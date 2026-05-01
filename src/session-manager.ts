import type { TM1Config } from "./config.js";
import { createLogger } from "./logger.js";
import type pino from "pino";

const USER_AGENT = "tm1-mcp-server/0.1.0";

export class SessionManager {
  private sessionCookie: string | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: TM1Config;
  private readonly logger: pino.Logger;

  constructor(config: TM1Config, logger?: pino.Logger) {
    this.config = config;
    this.logger = logger ?? createLogger(config);
  }

  /**
   * Authenticate against TM1 using native Basic Auth.
   * GET /api/v1/Configuration/ProductVersion with Authorization header.
   * Extracts TM1SessionId cookie from the response.
   */
  async authenticate(): Promise<string> {
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
    const credentials = Buffer.from(
      `${this.config.user}:${this.config.password}`
    ).toString("base64");

    this.logger.info({ endpoint: url }, "Authenticating with TM1");

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs
    );

    try {
      if (!this.config.ssl.rejectUnauthorized) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      }

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "TM1-SessionContext": USER_AGENT,
          "TM1-Session-Context": USER_AGENT,
        },
        signal: controller.signal,
      });

      // Always consume body to release connection
      const responseText = await response.text();

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
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Authentication request timed out after ${this.config.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs
    );

    try {
      if (!this.config.ssl.rejectUnauthorized) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      }

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Cookie: `TM1SessionId=${this.sessionCookie}`,
          "User-Agent": USER_AGENT,
          "TM1-SessionContext": USER_AGENT,
          "TM1-Session-Context": USER_AGENT,
        },
        signal: controller.signal,
      });

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
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        this.logger.error("Keep-alive request timed out");
        return;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Ensure an active session exists. If no session cookie is present,
   * authenticate first. Returns the session cookie.
   */
  async ensureSession(): Promise<string> {
    if (this.sessionCookie) {
      return this.sessionCookie;
    }
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
      if (!this.config.ssl.rejectUnauthorized) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      }

      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          Cookie: `TM1SessionId=${this.sessionCookie}`,
          "User-Agent": USER_AGENT,
          "TM1-SessionContext": USER_AGENT,
          "TM1-Session-Context": USER_AGENT,
        },
      });

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
  private extractSessionCookie(response: Response): string | null {
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) return null;

    const match = setCookie.match(/TM1SessionId=([^;]+)/);
    return match ? match[1] : null;
  }

}
