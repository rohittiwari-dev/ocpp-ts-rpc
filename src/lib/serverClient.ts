import WebSocket, { OPEN } from "ws";
import RPC_Client, { RPC_ClientOptions } from "./client";
import { IncomingHttpHeaders, IncomingMessage } from "http";

export interface IHandshakeInterface {
	remoteAddress: string | undefined;
	headers: IncomingHttpHeaders;
	protocols: Set<string>;
	endpoint: string;
	identity: string;
	query: URLSearchParams;
	request: IncomingMessage;
	password: Buffer | undefined;
}

class RpcServerClient extends RPC_Client {
	private _session: Record<string, any>;
	private _handshake: IHandshakeInterface;
	constructor(
		{ ...options }: RPC_ClientOptions,
		{
			ws,
			handshake,
			session,
		}: {
			ws: WebSocket;
			session: Record<string, any>;
			handshake: IHandshakeInterface;
		},
	) {
		super({ ...options });
		this._session = session;
		this._handshake = handshake;
		this._state = OPEN;
		this._identity = this._options.identity;
		this._ws = ws;
		this._protocol = ws.protocol;
		this._attachWebsocket(this._ws);
	}

	get handshake() {
		return this._handshake;
	}

	get session() {
		return this._session;
	}

	async connect() {
		throw Error("Cannot connect from server to client");
	}
}

export default RpcServerClient;
