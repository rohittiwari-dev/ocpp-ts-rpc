import http from "http";
import { Socket } from "net";

export function abortHandshake(
	socket: Socket,
	code: number | string,
	message?: string,
	headers?: Record<string, any>,
) {
	if (socket.writable) {
		message = (message || http.STATUS_CODES[code]) as string;

		headers = {
			Connection: "close",
			"Content-Type": "text/html",
			"Content-Length": Buffer.byteLength(message),
			...headers,
		};

		socket.write(
			`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n` +
				Object.keys(headers)
					.map(
						(h: string) =>
							`${h}: ${(headers as Record<string, any>)[h]}`,
					)
					.join("\r\n") +
				"\r\n\r\n" +
				message,
		);
	}

	socket.removeAllListeners("error");
	socket.destroy();
}

const tokenChars = [
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0, // 0 - 15
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0, // 16 - 31
	0,
	1,
	0,
	1,
	1,
	1,
	1,
	1,
	0,
	0,
	1,
	1,
	0,
	1,
	1,
	0, // 32 - 47
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	0,
	0,
	0,
	0,
	0,
	0, // 48 - 63
	0,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1, // 64 - 79
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	0,
	0,
	0,
	1,
	1, // 80 - 95
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1, // 96 - 111
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	0,
	1,
	0,
	1,
	0, // 112 - 127
];

export function parseSubprotocols(header: string) {
	const protocols = new Set<string>();
	let start = -1;
	let end = -1;
	let i = 0;

	for (i; i < header.length; i++) {
		const code = header.charCodeAt(i);

		if (end === -1 && tokenChars[code] === 1) {
			if (start === -1) start = i;
		} else if (
			i !== 0 &&
			(code === 0x20 /* ' ' */ || code === 0x09) /* '\t' */
		) {
			if (end === -1 && start !== -1) end = i;
		} else if (code === 0x2c /* ',' */) {
			if (start === -1) {
				throw new SyntaxError(`Unexpected character at index ${i}`);
			}

			if (end === -1) end = i;

			const protocol = header.slice(start, end);

			if (protocols.has(protocol)) {
				throw new SyntaxError(
					`The "${protocol}" subprotocol is duplicated`,
				);
			}

			protocols.add(protocol);
			start = end = -1;
		} else {
			throw new SyntaxError(`Unexpected character at index ${i}`);
		}
	}

	if (start === -1 || end !== -1) {
		throw new SyntaxError("Unexpected end of input");
	}

	const protocol = header.slice(start, i);

	if (protocols.has(protocol)) {
		throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
	}

	protocols.add(protocol);
	return protocols;
}

/**
 * Checks if a status code is allowed in a close frame.
 *
 * @param {Number} code The status code
 * @return {Boolean} `true` if the status code is valid, else `false`
 * @public
 */
export function isValidStatusCode(code: number) {
	return (
		(code >= 1000 &&
			code <= 1014 &&
			code !== 1004 &&
			code !== 1005 &&
			code !== 1006) ||
		(code >= 3000 && code <= 4999)
	);
}

export default {
	abortHandshake,
	parseSubprotocols,
	isValidStatusCode,
};
