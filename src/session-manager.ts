import type { TM1Config } from "./config.js";
import { createLogger } from "./logger.js";
import { getTm1Dispatcher, tm1Fetch } from "./tm1-client/dispatcher.js";
import { NAME, VERSION } from "./version.js";
import type pino from "pino";

const USER_AGENT = `${NAME}/${VERSION}`;

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

async function withTimeout<T>(
  ms: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new TimeoutError(label, ms);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class SessionManager {
  private sessionCookie: string | null = null;
  private authInFlight: Promise<string> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: TM1Config;
  private readonly logger: pino.Logger;

  constructor(config: TM1Config, logger?: pino.Logger) {
    this.config = config;
    this.logger = logger ?? createLogger(config);
  }

  /**
   * Authenticate against TM1. The auth scheme (Basic / CAMNamespace /
   * CAMPassport) is selected by config — see buildAuthorizationHeader.
   *
   * Concurrent callers share a single in-flight login. The HTTP transport
   * re-authenticates directly from its 401 handler (http.ts), so two requests
   * whose sessions expire at the same time both land here; without this dedup
   * each opens a fresh TM1 session and the second login's cookie clobbers the
   * first, leaving the first request retrying with a now-stale cookie (the
   * "thundering herd on session expiry" race). All re-auth paths — ensureSession,
   * keepAlive, and the transport 401 retry — funnel through this guard.
   */
  async authenticate(): Promise<string> {
    this.authInFlight ??= this.doAuthenticate().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  /**
   * Perform the actual login round-trip.
   * GET /api/v1/Configuration/ProductVersion with Authorization header.
   * Extracts TM1SessionId cookie from the response.
   */
  private async doAuthenticate(): Promise<string> {
    // Close any existing session before opening a new one — prevents
    // orphaned sessions accumulating on the TM1 server across re-auths.
    if (this.sessionCookie) {
      try {
        await this.logout();
      } catch (err) {
        this.logger.warn({ err }, "Failed to logout existing session before re-auth");
      }
    }

    const url = `${this.config.baseUrl}/api/v1/Configuration/ProductVersion`;
    const authorization = this.buildAuthorizationHeader();

    this.logger.info({ endpoint: url, authMode: this.authMode() }, "Authenticating with TM1");

    const response = await withTimeout(
      this.config.requestTimeoutMs,
      "Authentication",
      (signal) =>
        tm1Fetch(url, {
          method: "GET",
          headers: {
            Authorization: authorization,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            "TM1-SessionContext": USER_AGENT,
            "TM1-Session-Context": USER_AGENT,
          },
          signal,
          dispatcher: getTm1Dispatcher(this.config),
        } as unknown as RequestInit),
    );

    // Always consume body to release connection
    await response.text();

    if (!response.ok) {
      this.logger.error(
        { endpoint: url, status: response.status },
        "Authentication failed"
      );
      throw new Error(
        `Authentication failed with status ${response.status}: ${response.statusText}`
      );
    }

    const cookie = this.extractSessionCookie(response);
    if (!cookie) {
      throw new Error(
        "Authentication succeeded but no TM1SessionId cookie found in response"
      );
    }

    this.sessionCookie = cookie;
    this.logger.info("Authentication successful, session established");
    return cookie;
  }

  /**
   * Send a keep-alive request to maintain the active session.
   * GET /api/v1/ActiveSession with the session cookie.
   * On 401, triggers re-authentication.
   */
  async keepAlive(): Promise<void> {
    if (!this.sessionCookie) {
      this.logger.warn("No active session for keep-alive, re-authenticating");
      await this.authenticate();
      return;
    }

    const url = `${this.config.baseUrl}/api/v1/ActiveSession`;
    this.logger.debug({ endpoint: url }, "Sending keep-alive");

    let response: Response;
    try {
      response = await withTimeout(
        this.config.requestTimeoutMs,
        "Keep-alive",
        (signal) =>
          tm1Fetch(url, {
            method: "GET",
            headers: {
              Cookie: `TM1SessionId=${this.sessionCookie}`,
              "User-Agent": USER_AGENT,
              "TM1-SessionContext": USER_AGENT,
              "TM1-Session-Context": USER_AGENT,
            },
            signal,
            dispatcher: getTm1Dispatcher(this.config),
          } as unknown as RequestInit),
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        // Clear the cookie so the next real request re-authenticates up front
        // (via ensureSession) instead of serving the possibly-dead session and
        // eating a 401 round-trip under load. A keep-alive timeout is a strong
        // signal the session is no longer healthy.
        this.logger.error("Keep-alive request timed out; clearing session to force re-auth");
        this.sessionCookie = null;
        return;
      }
      throw err;
    }

    // Always consume body to release connection
    await response.text();

    if (response.status === 401) {
      this.logger.warn("Session expired during keep-alive, re-authenticating");
      this.sessionCookie = null;
      await this.authenticate();
      return;
    }

    if (!response.ok) {
      this.logger.error(
        { endpoint: url, status: response.status },
        "Keep-alive request failed"
      );
      throw new Error(
        `Keep-alive failed with status ${response.status}: ${response.statusText}`
      );
    }

    this.logger.debug("Keep-alive successful");
  }

  /**
   * Ensure an active session exists. If no session cookie is present,
   * authenticate first. Returns the session cookie.
   */
  async ensureSession(): Promise<string> {
    if (this.sessionCookie) {
      return this.sessionCookie;
    }
    // authenticate() dedupes concurrent logins internally (see its doc), so
    // first-auth races and 401 re-auth races share the same in-flight promise.
    return this.authenticate();
  }

  /**
   * Start periodic keep-alive requests at the configured interval.
   */
  startKeepAlive(): void {
    if (this.keepAliveTimer) {
      this.logger.debug("Keep-alive already running");
      return;
    }

    this.logger.info(
      { intervalMs: this.config.keepAliveIntervalMs },
      "Starting keep-alive timer"
    );

    this.keepAliveTimer = setInterval(() => {
      this.keepAlive().catch((err) => {
        this.logger.error({ err }, "Keep-alive error");
      });
    }, this.config.keepAliveIntervalMs);

    // Don't block Node.js from exiting
    if (this.keepAliveTimer.unref) {
      this.keepAliveTimer.unref();
    }
  }

  /**
   * Stop the periodic keep-alive timer.
   */
  stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      this.logger.info("Keep-alive timer stopped");
    }
  }

  /**
   * Check whether a session cookie is currently held.
   */
  isSessionActive(): boolean {
    return this.sessionCookie !== null;
  }

  /**
   * Logout from TM1 by deleting the active session.
   * DELETE /api/v1/ActiveSession
   */
  async logout(): Promise<void> {
    if (!this.sessionCookie) {
      return;
    }

    const url = `${this.config.baseUrl}/api/v1/ActiveSession`;
    this.logger.info("Logging out from TM1");

    try {
      // Bound the logout request — authenticate() calls logout() first, so a
      // hung DELETE (slow/unreachable server) would otherwise block re-auth
      // indefinitely. On timeout we still clear the cookie below.
      const response = await withTimeout(
        this.config.requestTimeoutMs,
        "Logout",
        (signal) =>
          tm1Fetch(url, {
            method: "DELETE",
            headers: {
              Cookie: `TM1SessionId=${this.sessionCookie}`,
              "User-Agent": USER_AGENT,
              "TM1-SessionContext": USER_AGENT,
              "TM1-Session-Context": USER_AGENT,
            },
            dispatcher: getTm1Dispatcher(this.config),
            signal,
          } as unknown as RequestInit),
      );

      // Consume body to release connection
      await response.text();

      this.sessionCookie = null;
      this.logger.info("Logged out from TM1");
    } catch (error) {
      this.logger.error({ err: error }, "Error during logout");
      this.sessionCookie = null;
    }
  }

  /**
   * Extract TM1SessionId from Set-Cookie response headers.
   */
  /**
   * Build the Authorization header value for the configured auth mode.
   *
   * Mirrors TM1py's RestService._build_authorization_token:
   *   - camPassport set → "CAMPassport <token>"
   *   - namespace set   → "CAMNamespace " + base64("user:password:namespace")
   *   - otherwise       → "Basic " + base64("user:password")
   *
   * The base64 input is UTF-8 encoded (TM1py uses str.encode(), i.e. UTF-8, and
   * Buffer.from defaults to UTF-8), so non-ASCII users/passwords/namespaces
   * round-trip identically. The CAMNamespace credential ordering is
   * user:password:namespace — confirmed against TM1py and IBM PA REST docs.
   */
  private buildAuthorizationHeader(): string {
    const { user, password, namespace, camPassport } = this.config;
    if (camPassport) {
      return `CAMPassport ${camPassport}`;
    }
    if (namespace) {
      const token = Buffer.from(`${user}:${password}:${namespace}`).toString("base64");
      return `CAMNamespace ${token}`;
    }
    const token = Buffer.from(`${user}:${password}`).toString("base64");
    return `Basic ${token}`;
  }

  /** Human-readable auth mode for logging (never logs the credential itself). */
  private authMode(): "CAMPassport" | "CAMNamespace" | "Basic" {
    if (this.config.camPassport) return "CAMPassport";
    if (this.config.namespace) return "CAMNamespace";
    return "Basic";
  }

  /**
   * Extract TM1SessionId Set-Cookie response headers.
   */
  private extractSessionCookie(response: Response): string | null {
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) return null;

    const match = setCookie.match(/TM1SessionId=([^;]+)/);
    return match ? match[1] ?? null : null;
  }

}
