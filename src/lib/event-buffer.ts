import { EventEmitter } from "stream";

class EventBuffer {
	private _emitter: EventEmitter;
	private _event: string | symbol;
	private _collector: (...args: any) => void;
	private _buffer: any;
	constructor(emitter: EventEmitter, event: string | symbol) {
		this._emitter = emitter;
		this._event = event;

		this._collector = (...args: any) => {
			this._buffer.push(args);
		};
		this._buffer = [];
		this._emitter.on(event, this._collector);
	}

	condense() {
		this._emitter.off(this._event, this._collector);
		return this._buffer;
	}
}

export default EventBuffer;
