// TM1 facade. Domain-specific OData calls live in service classes
// (`this.cubes`, etc.) — see docs/ARCHITECTURE.md. Connection lifecycle
// (authenticate / keep-alive / logout) lives here; everything else is
// delegated to the relevant service.
import type pino from "pino";
import type { TM1Config } from "./config.js";
import type { SessionManager } from "./session-manager.js";
import { TM1HttpClient } from "./tm1-client/http.js";
import { CubeService } from "./tm1-client/services/cube-service.js";
import { DimensionService } from "./tm1-client/services/dimension-service.js";
import { HierarchyService } from "./tm1-client/services/hierarchy-service.js";
import { ElementService } from "./tm1-client/services/element-service.js";
import { CellService } from "./tm1-client/services/cell-service.js";
import { ViewService } from "./tm1-client/services/view-service.js";
import { SubsetService } from "./tm1-client/services/subset-service.js";
import { ProcessService } from "./tm1-client/services/process-service.js";
import { ChoreService } from "./tm1-client/services/chore-service.js";
import { SecurityService } from "./tm1-client/services/security-service.js";
import { ServerService } from "./tm1-client/services/server-service.js";
import { MonitoringService } from "./tm1-client/services/monitoring-service.js";
import { FileService } from "./tm1-client/services/file-service.js";

export class TM1Client {
  private connected = false;

  // Transport is HELD, not inherited. Because TM1Client no longer `extends`
  // TM1HttpClient, its public type does not expose `request()/requestRaw()/
  // requestBinary()`, so a tool typed on TM1Client cannot call raw REST — that
  // is now a compile error (`tsc`), not just a `lint:no-flat-api` failure.
  // Services that legitimately need transport receive `this.http` explicitly.
  private readonly http: TM1HttpClient;
  private readonly sessionManager: SessionManager;
  private readonly logger: pino.Logger;
  private readonly config: TM1Config;

  // Domain services. Init order matters when services depend on each other —
  // `cells` is created before `elements` because the latter holds a CellService
  // ref for the element-attribute-value methods that route through MDX/cellset.
  readonly cubes: CubeService;
  readonly dimensions: DimensionService;
  readonly hierarchies: HierarchyService;
  readonly cells: CellService;
  readonly views: ViewService;
  readonly subsets: SubsetService;
  readonly elements: ElementService;
  readonly processes: ProcessService;
  readonly chores: ChoreService;
  readonly security: SecurityService;
  readonly server: ServerService;
  readonly monitoring: MonitoringService;
  readonly files: FileService;

  constructor(config: TM1Config, sessionManager: SessionManager, logger: pino.Logger) {
    this.config = config;
    this.http = new TM1HttpClient(config, sessionManager, logger);
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.cubes = new CubeService(this.http);
    this.dimensions = new DimensionService(this.http);
    this.hierarchies = new HierarchyService(this.http);
    this.cells = new CellService(this.http);
    this.views = new ViewService(this.http);
    this.subsets = new SubsetService(this.http);
    // ElementService depends on CellService — `cells` MUST be constructed above.
    // Enforced at runtime so a future reorder fails loudly instead of injecting
    // `undefined` (TS types it as defined, so the compiler won't catch a move).
    if (!this.cells) {
      throw new Error("TM1Client init order: CellService must be constructed before ElementService");
    }
    this.elements = new ElementService(this.http, this.cells);
    this.processes = new ProcessService(this.http);
    this.chores = new ChoreService(this.http);
    this.security = new SecurityService(this.http);
    this.server = new ServerService(this.http);
    this.monitoring = new MonitoringService(this.http);
    this.files = new FileService(this.http);
  }

  /** The configured TM1 major version (11 or 12). Fixed for this connection. */
  get version(): 11 | 12 {
    return this.config.version;
  }

  /**
   * Authenticate and start the keep-alive timer.
   */
  async connect(): Promise<void> {
    this.logger.info("Connecting to TM1 server");
    await this.sessionManager.authenticate();
    this.sessionManager.startKeepAlive();
    this.connected = true;
    this.logger.info("Connected to TM1 server");
  }

  /**
   * Stop the keep-alive timer and mark as disconnected.
   */
  async disconnect(): Promise<void> {
    this.logger.info("Disconnecting from TM1 server");
    this.sessionManager.stopKeepAlive();
    await this.sessionManager.logout();
    this.connected = false;
    this.logger.info("Disconnected from TM1 server");
  }

  isConnected(): boolean {
    return this.connected;
  }
}
