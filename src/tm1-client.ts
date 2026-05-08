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

export class TM1Client extends TM1HttpClient {
  private connected = false;

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
    super(config, sessionManager, logger);
    this.cubes = new CubeService(this);
    this.dimensions = new DimensionService(this);
    this.hierarchies = new HierarchyService(this);
    this.cells = new CellService(this);
    this.views = new ViewService(this);
    this.subsets = new SubsetService(this);
    this.elements = new ElementService(this, this.cells);
    this.processes = new ProcessService(this);
    this.chores = new ChoreService(this);
    this.security = new SecurityService(this);
    this.server = new ServerService(this);
    this.monitoring = new MonitoringService(this);
    this.files = new FileService(this);
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
