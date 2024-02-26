import RPCServer from "./lib/server";
import { createRPCError } from "./lib/util";

const server = new RPCServer({
	protocols: ["ocpp1.6"], // server accepts ocpp1.6 subprotocol
	strictMode: true, // enable strict validation of requests & responses
});

server.auth((accept, reject, handshake) => {
	// accept the incoming client
	accept({
		// anything passed to accept() will be attached as a 'session' property of the client.
		sessionId: "XYZ123",
	});
});

server.on("client", async (client) => {
	console.log(`${client.session.sessionId} connected!`); // `XYZ123 connected!`

	// create a specific handler for handling BootNotification requests
	client.handle("BootNotification", ({ params }) => {
		console.log(
			`Server got BootNotification from ${client.identity}:`,
			params,
		);

		// respond to accept the client
		return {
			status: "Accepted",
			interval: 300,
			currentTime: new Date().toISOString(),
		};
	});

	// create a specific handler for handling Heartbeat requests
	client.handle("Heartbeat", ({ params }) => {
		console.log(`Server got Heartbeat from ${client.identity}:`, params);

		// respond with the server's current time.
		return {
			currentTime: new Date().toISOString(),
		};
	});

	// create a specific handler for handling StatusNotification requests
	client.handle("StatusNotification", ({ params }) => {
		console.log(
			`Server got StatusNotification from ${client.identity}:`,
			params,
		);
		return {};
	});

	// create a wildcard handler to handle any RPC method
	client.handle(({ method, params }) => {
		// This handler will be called if the incoming method cannot be handled elsewhere.
		console.log(`Server got ${method} from ${client.identity}:`, params);

		// throw an RPC error to inform the server that we don't understand the request.
		throw createRPCError("NotImplemented");
	});
});

server.listen(3000).then(() => {
	console.log("🟢 Server Started at Port : ", 3000);
	console.log("🟢 Websocket Url : ws://localhost:", 3000);
	console.info(
		"Just Add this url to your charger or charger simulator,\neg : ws://localhost:{port}/{chargerId}",
	);
});
