// All Imports for Rpc Clients
import EventEmitter, { once } from "events";
import { Validator } from "./validator";
import Queue from "./queue";
import WebSocket, { CLOSED, CLOSING, CONNECTING, OPEN } from "ws";
import { setTimeout as setTimeoutCb } from "timers";
import { ExponentialStrategy } from "backoff";
import standardValidators from "./standard-validators";
import { createRPCError, getErrorPlainObject, getPackageIdent } from "./util";
import {
	RPCFrameworkError,
	RPCGenericError,
	RPCMessageTypeNotSupportedError,
	TimeoutError,
	UnexpectedHttpResponse,
} from "./errors";
import EventBuffer from "./event-buffer";
import { randomUUID } from "crypto";
import { isValidStatusCode } from "./ws-util";
import NOREPLY from "./symbols";

// RPcOption Interface Declarations
export interface RPC_ClientOptions {
	identity: string;
	reconnect: boolean;
	callTimeoutMs: number;
	pingIntervalMs: number;
	deferPingsOnActivity: boolean;
	respondWithDetailedErrors: boolean;
	callConcurrency: number;
	strictMode: boolean | string[];
	strictModeValidators: Validator[];
	maxBadMessages: number;
	protocols: string[];
	endpoint?: string;
	password: string | null;
	wsOpts: any;
	headers: any;
	maxReconnects: number;
	query?: string | Record<string, any>;
	backoff: {
		initialDelay: number;
		maxDelay: number;
		factor: number;
		randomisationFactor: number;
	};
}

// Types of call declarations
const MSG_CALL = 2;
const MSG_CALLRESULT = 3;
const MSG_CALLERROR = 4;

// Creating Custom Rpc CLient Emitter
class RPC_Client extends EventEmitter {
	// Data Member Declarations
	_identity?: string;
	_wildcardHandler: Function | null;
	_handlers: Map<string, Function>;
	_state: number;
	_callQueue: Queue;
	_ws?: WebSocket;
	_wsAbortController?: AbortController;
	_keepAliveAbortController?: AbortController;
	_pendingPingResponse: boolean;
	_lastPingTime: number;
	_closePromise?: Promise<{ code: number; reason: string }>;
	_protocolOptions: string[];
	_protocol?: string;
	_strictProtocols: string[];
	_strictValidators?: Map<string, Validator>;
	_pendingCalls: Map<string, Record<string, any>>;
	_pendingResponses: Map<
		string,
		{
			abort: {
				(reason?: any): void;
				(reason?: any): void;
			};
			promise: Promise<any>;
		}
	>;
	_outboundMsgBuffer: string[];
	_connectedOnce: boolean;
	_backoffStrategy?: ExponentialStrategy;
	_badMessagesCount: number;
	_reconnectAttempt: number;
	_options: RPC_ClientOptions;
	_connectionUrl!: string;
	_connectPromise!: Promise<{ response: any }>;
	_nextPingTimeout!: NodeJS.Timeout;
	// Static Declaration of data members
	static OPEN: number;
	static CONNECTING: number;
	static CLOSING: number;
	static CLOSED: number;

	// Constructor to initialize the Emitter
	constructor({ ...options }: RPC_ClientOptions) {
		super();
		// Initializing required data members at initialization
		this._identity = undefined;
		this._wildcardHandler = null;
		this._handlers = new Map();
		this._state = CLOSED;
		this._callQueue = new Queue();
		this._ws = undefined;
		this._wsAbortController = undefined;
		this._keepAliveAbortController = undefined;
		this._pendingPingResponse = false;
		this._lastPingTime = 0;
		this._closePromise = undefined;
		this._protocolOptions = [];
		this._protocol = undefined;
		this._strictProtocols = [];
		this._strictValidators = undefined;
		this._pendingCalls = new Map();
		this._pendingResponses = new Map();
		this._outboundMsgBuffer = [];
		this._connectedOnce = false;
		this._backoffStrategy = undefined;
		this._badMessagesCount = 0;
		this._reconnectAttempt = 0;
		this._options = {
			// defaults
			endpoint: "ws://localhost",
			password: null,
			callTimeoutMs: 1000 * 60,
			pingIntervalMs: 1000 * 30,
			deferPingsOnActivity: false,
			wsOpts: {},
			headers: {},
			protocols: [],
			reconnect: true,
			maxReconnects: Infinity,
			respondWithDetailedErrors: false,
			callConcurrency: 1,
			maxBadMessages: Infinity,
			identity: "",
			strictMode: false,
			strictModeValidators: [],
			backoff: {
				initialDelay: 1000,
				maxDelay: 10 * 1000,
				factor: 2,
				randomisationFactor: 0.25,
			},
		};

		// Reconfiguring options with new Options provided user calls
		this.reconfigure({ ...options });
	}

	// Getters
	get identity() {
		return this._identity;
	}
	get protocol() {
		return this._protocol;
	}
	get state() {
		return this._state;
	}

	/* Member Functions */
	// Function to reconfigure Options
	reconfigure(options: RPC_ClientOptions) {
		const newOpts = Object.assign(this._options, options);
		// check for identify important
		if (!newOpts.identity) {
			throw Error(`'identity' is required`);
		}

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

		this._strictProtocols = [];
		if (Array.isArray(newOpts.strictMode)) {
			this._strictProtocols = newOpts.strictMode;
		} else if (newOpts.strictMode) {
			this._strictProtocols = newOpts.protocols;
		}

		const missingValidator = this._strictProtocols.find(
			(protocol) => !this._strictValidators?.has(protocol),
		);
		if (missingValidator) {
			throw Error(
				`Missing strictMode validator for subprotocol '${missingValidator}'`,
			);
		}

		this._callQueue.setConcurrency(newOpts.callConcurrency);
		this._backoffStrategy = new ExponentialStrategy(newOpts.backoff);

		if ("pingIntervalMs" in options) {
			this._keepAlive();
		}
	}

	/**
	 * Attempt to connect to the RPCServer.
	 * @returns {Promise<undefined>} Resolves when connected, rejects on failure
	 */
	async connect(): Promise<any> {
		this._protocolOptions = this._options.protocols ?? [];
		this._protocol = undefined;
		this._identity = this._options.identity;

		let connUrl =
			this._options.endpoint +
			"/" +
			encodeURIComponent(
				this._options.identity as string | number | boolean,
			);
		if (this._options.query) {
			const searchParams = new URLSearchParams(this._options.query);
			connUrl += "?" + searchParams.toString();
		}

		this._connectionUrl = connUrl;

		if (this._state === CLOSING) {
			throw Error(`Cannot connect while closing`);
		}

		if (this._state === OPEN) {
			// no-op
			return;
		}

		if (this._state === CONNECTING) {
			return this._connectPromise;
		}

		try {
			return await this._beginConnect();
		} catch (err) {
			this._state = CLOSED;
			this.emit("close", { code: 1006, reason: "Abnormal Closure" });
			throw err;
		}
	}

	async _keepAlive() {
		// abort any previously running keepAlive
		this._keepAliveAbortController?.abort();

		const timerEmitter = new EventEmitter();
		const nextPingTimeout = setTimeoutCb(() => {
			timerEmitter.emit("next");
		}, this._options.pingIntervalMs);
		this._nextPingTimeout = nextPingTimeout;

		try {
			if (this._state !== OPEN) {
				// don't start pinging if connection not open
				return;
			}

			if (
				!this._options.pingIntervalMs ||
				this._options.pingIntervalMs <= 0 ||
				this._options.pingIntervalMs > 2147483647
			) {
				// don't ping for unusuable intervals
				return;
			}

			// setup new abort controller
			this._keepAliveAbortController = new AbortController();

			while (true) {
				await once(timerEmitter, "next", {
					signal: this._keepAliveAbortController.signal,
				}),
					this._keepAliveAbortController.signal.throwIfAborted();

				if (this._state !== OPEN) {
					// keepalive no longer required
					break;
				}

				if (this._pendingPingResponse) {
					// we didn't get a response to our last ping
					throw Error("Ping timeout");
				}

				this._lastPingTime = Date.now();
				this._pendingPingResponse = true;
				this._ws?.ping();
				nextPingTimeout.refresh();
			}
		} catch (err: any) {
			// console.log('keepalive failed', err);
			if (err.name !== "AbortError") {
				// throws on ws.ping() error
				this._ws?.terminate();
			}
		} finally {
			clearTimeout(nextPingTimeout);
		}
	}

	async _tryReconnect() {
		this._reconnectAttempt++;
		if (this._reconnectAttempt > this._options.maxReconnects) {
			// give up
			this.close({ code: 1001, reason: "Giving up" });
		} else {
			try {
				// Usage
				this._state = CONNECTING;
				const delayMs = this._backoffStrategy?.next() as number;
				await setTimeout(() => {}, delayMs, {
					signal: this._wsAbortController?.signal,
				});

				await this._beginConnect()
					.catch(async (err: { message: string }) => {
						const intolerableErrors = [
							"Maximum redirects exceeded",
							"Server sent no subprotocol",
							"Server sent an invalid subprotocol",
							"Server sent a subprotocol but none was requested",
							"Invalid Sec-WebSocket-Accept header",
						];

						if (intolerableErrors.includes(err.message)) {
							throw err;
						}

						this._tryReconnect();
					})
					.catch((err: { message: any }) => {
						this.close({ code: 1001, reason: err.message });
					});
			} catch (err) {
				// aborted timeout
				return;
			}
		}
	}

	_beginConnect() {
		this._connectPromise = (async () => {
			this._wsAbortController = new AbortController();

			const wsOpts = Object.assign(
				{
					// defaults
					noDelay: true,
					signal: this._wsAbortController.signal,
					headers: {
						"user-agent": getPackageIdent(),
						authorization: "",
					},
				},
				this._options.wsOpts ?? {},
			);

			Object.assign(wsOpts.headers, this._options.headers);

			if (this._options.password != null) {
				const usernameBuffer = Buffer.from(this._identity + ":");
				let passwordBuffer: any = this._options.password;
				if (typeof passwordBuffer === "string") {
					passwordBuffer = Buffer.from(passwordBuffer, "utf8");
				}

				const b64 = Buffer.concat([
					usernameBuffer,
					passwordBuffer,
				]).toString("base64");
				wsOpts.headers.authorization = "Basic " + b64;
			}

			this._ws = new WebSocket(
				this._connectionUrl,
				this._protocolOptions,
				wsOpts,
			);

			const leadMsgBuffer = new EventBuffer(this._ws, "message");
			let upgradeResponse;

			try {
				await new Promise((resolve, reject) => {
					this._ws?.once(
						"unexpected-response",
						(
							request: any,
							response: {
								statusMessage: string | undefined;
								statusCode: any;
							},
						) => {
							const err = new UnexpectedHttpResponse(
								response.statusMessage,
							);
							err.code = response.statusCode;
							err.request = request;
							err.response = response;
							reject(err);
						},
					);
					this._ws?.once("upgrade", (response: any) => {
						upgradeResponse = response;
					});
					this._ws?.once("error", (err: any) => reject(err));
					this._ws?.once("open", () => resolve(""));
				});

				// record which protocol was selected
				if (this._protocol === undefined) {
					this._protocol = this._ws.protocol;
					this.emit("protocol", this._protocol);
				}

				// limit protocol options in case of future reconnect
				this._protocolOptions = this._protocol ? [this._protocol] : [];

				this._reconnectAttempt = 0;
				this._backoffStrategy?.reset();
				this._state = OPEN;
				this._connectedOnce = true;
				this._pendingPingResponse = false;

				this._attachWebsocket(this._ws, leadMsgBuffer);

				// send queued messages
				if (this._outboundMsgBuffer.length > 0) {
					const buff = this._outboundMsgBuffer;
					this._outboundMsgBuffer = [];
					buff.forEach((msg) => this.sendRaw(msg));
				}

				const result = {
					response: upgradeResponse,
				};

				this.emit("open", result);
				return result;
			} catch (err: any) {
				this._ws.terminate();
				if (upgradeResponse) {
					err.upgrade = upgradeResponse;
				}
				throw err;
			}
		})();

		this._state = CONNECTING;
		this.emit("connecting", { protocols: this._protocolOptions });

		return this._connectPromise;
	}

	/**
	 * Start consuming from a WebSocket
	 * @param {WebSocket} ws - A WebSocket instance
	 * @param {EventBuffer} leadMsgBuffer - A buffer which traps all 'message' events
	 */
	_attachWebsocket(ws: WebSocket, leadMsgBuffer?: EventBuffer) {
		ws.once("close", (code: number, reason: Buffer) =>
			this._handleDisconnect({ code, reason }),
		);
		ws.on("error", (err: Error) => this.emit("socketError", err));
		ws.on("ping", () => {
			if (this._options.deferPingsOnActivity) {
				this._deferNextPing();
			}
		});
		ws.on("pong", () => {
			if (this._options.deferPingsOnActivity) {
				this._deferNextPing();
			}
			this._pendingPingResponse = false;
			const rtt = Date.now() - this._lastPingTime;
			this.emit("ping", { rtt });
		});

		this._keepAlive();

		process.nextTick(() => {
			if (leadMsgBuffer) {
				const messages = leadMsgBuffer.condense();
				messages.forEach(([msg]: any[]) => this._onMessage(msg));
			}
			ws.on("message", (msg: any) => this._onMessage(msg));
		});
	}

	_handleDisconnect({ code, reason }: { code: number; reason: Buffer }) {
		let reasonString: string = "";
		if (reason instanceof Buffer) {
			reasonString = reason.toString("utf8");
		}

		// reject any outstanding calls/responses
		this._rejectPendingCalls("Client disconnected");
		this._keepAliveAbortController?.abort();

		this.emit("disconnect", { code, reasonString });

		if (this._state === CLOSED) {
			// nothing to do here
			return;
		}

		if (this._state !== CLOSING && this._options.reconnect) {
			this._tryReconnect();
		} else {
			this._state = CLOSED;
			this.emit("close", { code, reasonString });
		}
	}
	_rejectPendingCalls(abortReason: string) {
		const pendingCalls = Array.from(this._pendingCalls.values());
		const pendingResponses = Array.from(this._pendingResponses.values());
		[...pendingCalls, ...pendingResponses].forEach((c) =>
			c.abort(abortReason),
		);
	}

	/**
	 * Call a method on a remote RPCClient or RPCServerClient.
	 * @param {string} method - The RPC method to call.
	 * @param {*} params - A value to be passed as params to the remote handler.
	 * @param {Object} options - Call options
	 * @param {number} options.callTimeoutMs - Call timeout (in milliseconds)
	 * @param {AbortSignal} options.signal - AbortSignal to cancel the call.
	 * @param {boolean} options.noReply - If set to true, the call will return immediately.
	 * @returns Promise<*> - Response value from the remote handler.
	 */
	async call(method: any, params?: any, options: Record<string, any> = {}) {
		return await this._callQueue.push(
			this._call.bind(this, method, params, options),
		);
	}

	async _call(method: any, params: any, options: Record<string, any> = {}) {
		const timeoutMs = options.callTimeoutMs ?? this._options.callTimeoutMs;

		if (([CLOSED, CLOSING] as Array<number>).includes(this._state)) {
			throw Error(`Cannot make call while socket not open`);
		}

		const msgId = randomUUID();
		const payload = [MSG_CALL, msgId, method, params];

		if (this._strictProtocols.includes(this._protocol as string)) {
			// perform some strict-mode checks
			const validator = this._strictValidators?.get(
				this._protocol as string,
			);
			try {
				validator?.validate(`urn:${method}.req`, params);
			} catch (error) {
				this.emit("strictValidationFailure", {
					messageId: msgId,
					method,
					params,
					result: null,
					error,
					outbound: true,
					isCall: true,
				});
				throw error;
			}
		}

		const pendingCall: Record<string, any> = {};

		if (!options.noReply) {
			const timeoutAc = new AbortController();

			const cleanup = () => {
				if (pendingCall.timeout) {
					timeoutAc.abort();
				}
				this._pendingCalls.delete(msgId);
			};

			pendingCall.abort = (reason: string | undefined) => {
				const err = Error(reason);
				err.name = "AbortError";
				pendingCall.reject(err);
			};

			if (options.signal) {
				once(options.signal, "abort").then(() => {
					pendingCall.abort(options.signal.reason);
				});
			}

			pendingCall.promise = new Promise((resolve, reject) => {
				pendingCall.resolve = (...args: any) => {
					cleanup();
					resolve({ ...args });
				};
				pendingCall.reject = (...args: any) => {
					cleanup();
					reject(...args);
				};
			});

			if (timeoutMs && timeoutMs > 0 && timeoutMs < Infinity) {
				const timeoutError = new TimeoutError("Call timeout");
				pendingCall.timeout = setTimeout(
					() => {
						pendingCall.reject(timeoutError);
					},
					timeoutMs,
					{
						signal: timeoutAc.signal,
					},
				);
			}

			this._pendingCalls.set(msgId, pendingCall);
		}

		this.emit("call", { outbound: true, payload });
		this.sendRaw(JSON.stringify(payload));

		if (options.noReply) {
			return;
		}

		try {
			const result = await pendingCall.promise;

			this.emit("callResult", {
				outbound: true,
				messageId: msgId,
				method,
				params,
				result,
			});

			return result;
		} catch (err) {
			this.emit("callError", {
				outbound: true,
				messageId: msgId,
				method,
				params,
				error: err,
			});

			throw err;
		}
	}

	/**
	 * Closes the RPCClient.
	 * @param {Object} options - Close options
	 * @param {number} options.code - The websocket CloseEvent code.
	 * @param {string} options.reason - The websocket CloseEvent reason.
	 * @param {boolean} options.awaitPending - Wait for in-flight calls & responses to complete before closing.
	 * @param {boolean} options.force - Terminate websocket immediately without passing code, reason, or waiting.
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code CloseEvent codes}
	 * @returns Promise<Object> - The CloseEvent (code & reason) for closure. May be different from requested code & reason.
	 */
	async close({
		code,
		reason,
		awaitPending,
		force,
	}: {
		code?: number;
		reason?: string;
		awaitPending?: any;
		force?: any;
	} = {}) {
		if (([CLOSED, CLOSING] as Array<number>).includes(this._state)) {
			// no-op
			return this._closePromise;
		}

		if (this._state === OPEN) {
			this._closePromise = (async () => {
				if (force || !awaitPending) {
					// reject pending calls
					this._rejectPendingCalls("Client going away");
				}

				if (force && this._ws) {
					this._ws.terminate();
				} else {
					// await pending calls & responses
					await this._awaitUntilPendingSettled();
					if (!code || !isValidStatusCode(code)) {
						code = 1000;
					}
					this._ws?.close(code, reason);
				}

				let [codeRes, reasonRes] = await once(
					this._ws as WebSocket,
					"close",
				);

				if (reasonRes instanceof Buffer) {
					reasonRes = reasonRes.toString("utf8");
				}

				return { code: codeRes, reason: reasonRes };
			})();

			this._state = CLOSING;
			this._connectedOnce = false;
			this.emit("closing");

			return this._closePromise;
		} else if (this._wsAbortController) {
			const result = this._connectedOnce
				? { code, reason }
				: { code: 1001, reason: "Connection aborted" };

			this._wsAbortController.abort();
			this._state = CLOSED;
			this._connectedOnce = false;
			this.emit("close", result);
			return result;
		}
	}
	async _awaitUntilPendingSettled() {
		const pendingCalls = Array.from(this._pendingCalls.values());
		const pendingResponses = Array.from(this._pendingResponses.values());
		return await Promise.allSettled([
			...pendingResponses.map((c) => c.promise),
			...pendingCalls.map((c) => c.promise),
		]);
	}
	_deferNextPing() {
		if (!this._nextPingTimeout) {
			return;
		}
		this._nextPingTimeout.refresh();
	}

	_onMessage(buffer: Buffer) {
		if (this._options.deferPingsOnActivity) {
			this._deferNextPing();
		}

		const message = buffer.toString("utf8");

		if (!message.length) {
			// ignore empty messages
			// for compatibility with some particular charge point vendors (naming no names)
			return;
		}

		this.emit("message", { message, outbound: false });

		let msgId = "-1";
		let messageType;

		try {
			let payload;
			try {
				payload = JSON.parse(message);
			} catch (err) {
				throw createRPCError(
					"RpcFrameworkError",
					"Message must be a JSON structure",
					{},
				);
			}

			if (!Array.isArray(payload)) {
				throw createRPCError(
					"RpcFrameworkError",
					"Message must be an array",
					{},
				);
			}

			const [messageTypePart, msgIdPart, ...more] = payload;

			if (typeof messageTypePart !== "number") {
				throw createRPCError(
					"RpcFrameworkError",
					"Message type must be a number",
					{},
				);
			}

			// Extension fallback mechanism
			// (see section 4.4 of OCPP2.0.1J)
			if (
				![MSG_CALL, MSG_CALLERROR, MSG_CALLRESULT].includes(
					messageTypePart,
				)
			) {
				throw createRPCError(
					"MessageTypeNotSupported",
					"Unrecognised message type",
					{},
				);
			}

			messageType = messageTypePart;

			if (typeof msgIdPart !== "string") {
				throw createRPCError(
					"RpcFrameworkError",
					"Message ID must be a string",
					{},
				);
			}

			msgId = msgIdPart;

			switch (messageType) {
				case MSG_CALL:
					const [method, params] = more;
					if (typeof method !== "string") {
						throw new RPCFrameworkError("Method must be a string");
					}
					this.emit("call", { outbound: false, payload });
					this._onCall(msgId, method, params);
					break;
				case MSG_CALLRESULT:
					const [result] = more;
					this.emit("response", { outbound: false, payload });
					this._onCallResult(msgId, result);
					break;
				case MSG_CALLERROR:
					const [errorCode, errorDescription, errorDetails] = more;
					this.emit("response", { outbound: false, payload });
					this._onCallError(
						msgId,
						errorCode,
						errorDescription,
						errorDetails,
					);
					break;
				default:
					throw new RPCMessageTypeNotSupportedError(
						`Unexpected message type: ${messageType}`,
					);
			}

			this._badMessagesCount = 0;
		} catch (error: any) {
			const shouldClose =
				++this._badMessagesCount >
				(this._options.maxBadMessages as number);

			let response: any = null;
			let errorMessage = "";

			if (
				![MSG_CALLERROR, MSG_CALLRESULT].includes(messageType as number)
			) {
				// We shouldn't respond to CALLERROR or CALLRESULT, but we may respond
				// to any CALL (or other unknown message type) with a CALLERROR
				// (see section 4.4 of OCPP2.0.1J - Extension fallback mechanism)
				const details =
					error.details ||
					(this._options.respondWithDetailedErrors
						? getErrorPlainObject(error)
						: {});

				errorMessage = error.message || error.rpcErrorMessage || "";

				response = [
					MSG_CALLERROR,
					msgId,
					error.rpcErrorCode || "GenericError",
					errorMessage,
					details ?? {},
				];
			}

			this.emit("badMessage", { buffer, error, response });

			if (shouldClose) {
				this.close({
					code: 1002,
					reason:
						error instanceof RPCGenericError
							? errorMessage
							: "Protocol error",
				});
			} else if (response && this._state === OPEN) {
				this.sendRaw(JSON.stringify(response));
			}
		}
	}
	async _onCall(msgId: string, method: string, params: any) {
		try {
			let payload;

			if (this._state !== OPEN) {
				throw Error("Call received while client state not OPEN");
			}

			try {
				if (this._pendingResponses.has(msgId)) {
					throw createRPCError(
						"RpcFrameworkError",
						`Already processing a call with message ID: ${msgId}`,
						{},
					);
				}
				let handler = this._handlers.get(method);
				if (!handler) {
					handler = this._wildcardHandler as Function;
				}

				if (!handler) {
					throw createRPCError(
						"NotImplemented",
						`Unable to handle '${method}' calls`,
						{},
					);
				}

				if (this._strictProtocols.includes(this._protocol as string)) {
					// perform some strict-mode checks
					const validator = this._strictValidators?.get(
						this._protocol as string,
					);
					try {
						validator?.validate(`urn:${method}.req`, params);
					} catch (error) {
						this.emit("strictValidationFailure", {
							messageId: msgId,
							method,
							params,
							result: null,
							error,
							outbound: false,
							isCall: true,
						});
						throw error;
					}
				}

				const ac = new AbortController();
				const callPromise = new Promise(async (resolve, reject) => {
					function reply(val: unknown) {
						if (val instanceof Error) {
							reject(val);
						} else {
							resolve(val);
						}
					}

					try {
						if (handler) {
							reply(
								await handler({
									messageId: msgId,
									method,
									params,
									signal: ac.signal,
									reply,
								}),
							);
						} else {
							throw new Error("Handler is not defined");
						}
					} catch (err) {
						reply(err);
					}
				});

				const pending = {
					abort: ac.abort.bind(ac),
					promise: callPromise,
				};
				this._pendingResponses.set(msgId, pending);
				const result = await callPromise;

				this.emit("callResult", {
					outbound: false,
					messageId: msgId,
					method,
					params,
					result,
				});

				if (result === NOREPLY) {
					return; // don't send a reply
				}

				payload = [MSG_CALLRESULT, msgId, result];

				if (this._strictProtocols.includes(this._protocol as any)) {
					// perform some strict-mode checks
					const validator = this._strictValidators?.get(
						this._protocol as string,
					);
					try {
						validator?.validate(`urn:${method}.conf`, result);
					} catch (error) {
						this.emit("strictValidationFailure", {
							messageId: msgId,
							method,
							params,
							result,
							error,
							outbound: true,
							isCall: false,
						});
						throw createRPCError("InternalError");
					}
				}
			} catch (err: any) {
				// catch here to prevent this error from being considered a 'badMessage'.

				const details =
					err.details ||
					(this._options.respondWithDetailedErrors
						? getErrorPlainObject(err)
						: {});

				let rpcErrorCode = err.rpcErrorCode || "GenericError";

				if (this.protocol === "ocpp1.6") {
					// Workaround for some mistakes in the spec in OCPP1.6J
					// (clarified in section 5 of OCPP1.6J errata v1.0)
					switch (rpcErrorCode) {
						case "FormatViolation":
							rpcErrorCode = "FormationViolation";
							break;
						case "OccurenceConstraintViolation":
							rpcErrorCode = "OccurrenceConstraintViolation";
							break;
					}
				}

				payload = [
					MSG_CALLERROR,
					msgId,
					rpcErrorCode,
					err.message || err.rpcErrorMessage || "",
					details ?? {},
				];

				this.emit("callError", {
					outbound: false,
					messageId: msgId,
					method,
					params,
					error: err,
				});
			} finally {
				this._pendingResponses.delete(msgId);
			}

			this.emit("response", { outbound: true, payload });
			this.sendRaw(JSON.stringify(payload));
		} catch (err) {
			this.close({ code: 1000, reason: "Unable to send call result" });
		}
	}
	_onCallResult(msgId: string, result: any) {
		const pendingCall = this._pendingCalls.get(msgId);
		if (pendingCall) {
			if (this._strictProtocols.includes(this._protocol as string)) {
				// perform some strict-mode checks
				const validator = this._strictValidators?.get(
					this._protocol as string,
				);
				try {
					validator?.validate(
						`urn:${pendingCall.method}.conf`,
						result,
					);
				} catch (error) {
					this.emit("strictValidationFailure", {
						messageId: msgId,
						method: pendingCall.method,
						params: pendingCall.params,
						result,
						error,
						outbound: false,
						isCall: false,
					});
					return pendingCall.reject(error);
				}
			}

			return pendingCall.resolve(result);
		} else {
			throw createRPCError(
				"RpcFrameworkError",
				`Received CALLRESULT for unrecognised message ID: ${msgId}`,
				{
					msgId,
					result,
				},
			);
		}
	}
	_onCallError(
		msgId: string,
		errorCode: string,
		errorDescription: string,
		errorDetails: Record<string, any>,
	) {
		const pendingCall = this._pendingCalls.get(msgId);
		if (pendingCall) {
			const err = createRPCError(
				errorCode,
				errorDescription,
				errorDetails,
			);
			pendingCall.reject(err);
		} else {
			throw createRPCError(
				"RpcFrameworkError",
				`Received CALLERROR for unrecognised message ID: ${msgId}`,
				{
					msgId,
					errorCode,
					errorDescription,
					errorDetails,
				},
			);
		}
	}

	/**
	 * Send a message to the RPCServer. While socket is connecting, the message is queued and send when open.
	 * @param {Buffer|String} message - String to send via websocket
	 */
	sendRaw(message: string) {
		if (
			([OPEN, CLOSING] as Array<number>).includes(this._state) &&
			this._ws
		) {
			// can send while closing so long as websocket doesn't mind
			this._ws.send(message);
			this.emit("message", { message, outbound: true });
		} else if (this._state === CONNECTING) {
			this._outboundMsgBuffer.push(message);
		} else {
			throw Error(`Cannot send message in this state`);
		}
	}

	/**
	 *
	 * @param {string} [method] - The name of the handled method.
	 */
	removeHandler(method: string) {
		this._handlers.delete(method);
	}

	removeAllHandlers() {
		this._wildcardHandler = null;
		this._handlers.clear();
	}

	/**
	 *
	 * @param {string} [method] - The name of the RPC method to handle.
	 * @param {Function} handler - A function that can handle incoming calls for this method.
	 */
	handle(
		method: string | Function,
		handler?: ({ params, signal }: { params: any; signal: any }) => void,
	) {
		if (method instanceof Function && !handler) {
			this._wildcardHandler = method;
		} else {
			this._handlers.set(method as string, handler as Function);
		}
	}
}

RPC_Client.OPEN = OPEN;
RPC_Client.CONNECTING = CONNECTING;
RPC_Client.CLOSING = CLOSING;
RPC_Client.CLOSED = CLOSED;

export default RPC_Client;
