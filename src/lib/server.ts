import { IncomingMessage, Server, createServer } from "http";
import {
	CLOSED,
	CLOSING,
	OPEN,
	ServerOptions,
	WebSocket,
	WebSocketServer,
} from "ws";
import { EventEmitter } from "stream";
import { Validator } from "./validator";
import RpcServerClient, { IHandshakeInterface } from "./serverClient";
import { Socket } from "net";
import { WebsocketUpgradeError } from "./errors";
import standardValidators from "./standard-validators";
import { getPackageIdent } from "./util";
import { parseSubprotocols } from "./ws-util";
import { RPC_ClientOptions } from "./client";
import { once } from "events";

interface IOccpServiceOptions {
	wssOptions?: ServerOptions;
	protocols?: string[];
	callTimeoutMs?: number;
	pingIntervalMs?: number;
	deferPingsOnActivity?: boolean;
	respondWithDetailedErrors?: boolean;
	callConcurrency?: number;
	maxBadMessages?: number;
	strictMode?: boolean | string[];
	strictModeValidators?: Validator[];
}

interface TPendingUpgrades {
	session: Record<string, any>;
	protocol: string;
	handshake: IHandshakeInterface;
}

class RPCServer extends EventEmitter {
	_httpServerAbortControllers: Set<AbortController>;
	_state: number;
	_clients: Set<RpcServerClient>;
	_pendingUpgrades: WeakMap<IncomingMessage, TPendingUpgrades>;
	_options: IOccpServiceOptions;
	_wss: WebSocketServer;
	_strictValidators!: Map<string, Validator>;
	authCallback!: (
		accept: (
			session?: Record<string, any>,
			protocol?: string | false
		) => void,
		reject: (code: number, message: string) => void,
		handshake: IHandshakeInterface,
		signal: AbortSignal
	) => void;

	// Websocket Constructor
	constructor({ ...options }: IOccpServiceOptions, _callback?: () => void) {
		super();
		this._httpServerAbortControllers = new Set();
		this._state = OPEN;
		this._clients = new Set();
		this._pendingUpgrades = new WeakMap();

		this._options = {
			// defaults
			wssOptions: {},
			protocols: [],
			callTimeoutMs: 1000 * 30,
			pingIntervalMs: 1000 * 30,
			deferPingsOnActivity: false,
			respondWithDetailedErrors: false,
			callConcurrency: 1,
			maxBadMessages: Infinity,
			strictMode: false,
			strictModeValidators: [],
		};

		this.reconfigure({ ...options });

		this._wss = new WebSocketServer({
			...this._options.wssOptions,
			noServer: true,
			handleProtocols: (protocols, request) => {
				const { protocol } = this._pendingUpgrades.get(
					request
				) as TPendingUpgrades;
				return protocol;
			},
		});

		this._wss.on("headers", (h: any) =>
			h.push(`Server: ${getPackageIdent()}`)
		);
		this._wss.on("error", (err: any) => this.emit("error", err));
		this._wss.on("connection", this._onConnection.bind(this));
	}

	reconfigure(options: any) {
		const newOpts = Object.assign({}, this._options, options);

		if (newOpts.strictMode && !newOpts.protocols?.length) {
			throw Error(`strictMode requires at least one subprotocol`);
		}

		const strictValidators = [...standardValidators];
		if (newOpts.strictModeValidators) {
			strictValidators.push(...newOpts.strictModeValidators);
		}

		this._strictValidators = strictValidators.reduce((svs, v) => {
			svs.set(v.subprotocol, v);
			return svs;
		}, new Map());

		let strictProtocols = [];
		if (Array.isArray(newOpts.strictMode)) {
			strictProtocols = newOpts.strictMode;
		} else if (newOpts.strictMode) {
			strictProtocols = newOpts.protocols;
		}

		const missingValidator = strictProtocols.find(
			(protocol: any) => !this._strictValidators.has(protocol)
		);
		if (missingValidator) {
			throw Error(
				`Missing strictMode validator for subprotocol '${missingValidator}'`
			);
		}

		this._options = newOpts;
	}

	async _onConnection(websocket: WebSocket, request: IncomingMessage) {
		try {
			if (this._state !== OPEN) {
				throw Error("Server is no longer open");
			}

			const { handshake, session } = this._pendingUpgrades.get(
				request
			) as TPendingUpgrades;

			const client = new RpcServerClient(
				{
					identity: handshake.identity,
					reconnect: false,
					callTimeoutMs: this._options.callTimeoutMs,
					pingIntervalMs: this._options.pingIntervalMs,
					deferPingsOnActivity: this._options.deferPingsOnActivity,
					respondWithDetailedErrors:
						this._options.respondWithDetailedErrors,
					callConcurrency: this._options.callConcurrency,
					strictMode: this._options.strictMode,
					strictModeValidators: this._options.strictModeValidators,
					maxBadMessages: this._options.maxBadMessages,
					protocols: this._options.protocols,
				} as RPC_ClientOptions,
				{
					ws: websocket,
					session,
					handshake,
				}
			);

			this._clients.add(client);
			client.once("close", () => this._clients.delete(client));
			this.emit("client", client);
		} catch (err: any) {
			websocket.close(err.statusCode || 1000, err.message);
		}
	}

	get handleUpgrade() {
		return async (
			request: IncomingMessage,
			socket: Socket,
			head: Buffer
		) => {
			let resolved = false;
			const url = new URL("http://localhost" + (request.url || "/"));
			const pathParts = url.pathname.split("/");
			const identity = decodeURIComponent(pathParts.pop() as string);

			const ac = new AbortController();
			const { signal } = ac;

			const abortUpgrade = (error: any) => {
				if (!signal.aborted) {
					ac.abort(error);
					this.emit("upgradeAborted", {
						error,
						socket,
						request,
						identity,
					});
				}
			};

			try {
				const headers = request.headers;

				if (headers.upgrade?.toLowerCase() !== "websocket") {
					throw new WebsocketUpgradeError(
						400,
						"Can only upgrade websocket upgrade requests"
					);
				}

				const protocols =
					"sec-websocket-protocol" in headers
						? parseSubprotocols(
								headers["sec-websocket-protocol"] as string
							)
						: new Set<string>();

				const handshake: IHandshakeInterface = {
					remoteAddress: request.socket.remoteAddress,
					headers,
					protocols,
					endpoint: pathParts.join("/") || "/",
					identity,
					query: url.searchParams,
					request,
					password: headers.authorization
						? Buffer.from(
								headers.authorization.split(" ")[1],
								"base64"
							)
						: undefined,
				};

				const accept = (session?: any, protocol?: any) => {
					if (resolved) return;
					resolved = true;

					try {
						if (socket.readyState !== "open") {
							throw new WebsocketUpgradeError(
								400,
								`Client readyState = '${socket.readyState}'`
							);
						}

						if (protocol === undefined) {
							protocol = (this._options.protocols ?? []).find(
								(p) => protocols.has(p)
							);
						} else if (
							protocol !== false &&
							!protocols.has(protocol)
						) {
							throw new WebsocketUpgradeError(
								400,
								`Client doesn't support expected subprotocol`
							);
						}

						this._pendingUpgrades.set(request, {
							session: session ?? {},
							protocol,
							handshake,
						});

						this._wss.handleUpgrade(
							request,
							socket,
							head,
							(ws: WebSocket) => {
								this._wss.emit("connection", ws, request);
							}
						);
					} catch (err) {
						abortUpgrade(err);
					}
				};

				const reject = (code = 404, message = "Not found") => {
					if (resolved) return;
					resolved = true;
					abortUpgrade(new WebsocketUpgradeError(code, message));
				};

				socket.once("end", () => {
					reject(
						400,
						`Client connection closed before upgrade complete`
					);
				});

				socket.once("close", () => {
					reject(
						400,
						`Client connection closed before upgrade complete`
					);
				});

				if (this.authCallback) {
					await this.authCallback(accept, reject, handshake, signal);
				} else {
					accept();
				}
			} catch (err) {
				abortUpgrade(err);
			}
		};
	}

	auth(
		cb: (
			accept: (
				session?: Record<string, any>,
				protocol?: string | false
			) => void,
			reject: (code: number, message: string) => void,
			handshake: IHandshakeInterface,
			signal?: AbortSignal
		) => void
	) {
		this.authCallback = cb;
	}

	async listen(port: any, host?: any, options?: Record<string, any>) {
		const ac = new AbortController();
		this._httpServerAbortControllers.add(ac);
		if (options?.signal) {
			once(options.signal, "abort").then(() => {
				ac.abort(options.signal.reason);
			});
		}
		const httpServer = createServer(
			{
				noDelay: true,
			},
			(_req, res) => {
				res.setHeader("Server", getPackageIdent());
				res.statusCode = 404;
				res.end();
			}
		);
		httpServer.on("upgrade", this.handleUpgrade);
		httpServer.once("close", () =>
			this._httpServerAbortControllers.delete(ac)
		);
		await new Promise((resolve, reject) => {
			return (httpServer as any).listen(
				{
					port,
					host,
					signal: ac.signal,
				},
				(err?: any) => (err ? reject(err) : resolve(""))
			) as Server;
		});
		return httpServer;
	}

	async close({ code, reason, awaitPending, force }: Record<string, any>) {
		if (this._state === OPEN) {
			this._state = CLOSING;
			this.emit("closing");
			code = code ?? 1001;
			await Array.from(this._clients).map((cli: any) =>
				cli.close({ code, reason, awaitPending, force })
			);
			await new Promise((resolve, reject) => {
				this._wss.close((err: any) =>
					err ? reject(err) : resolve("")
				);
				this._httpServerAbortControllers.forEach((ac: any) =>
					ac.abort("Closing")
				);
			});
			this._state = CLOSED;
			this.emit("close");
		}
	}
}

export default RPCServer;
