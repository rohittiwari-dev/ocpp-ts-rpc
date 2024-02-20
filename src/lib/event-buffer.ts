import { EventEmitter } from "stream";

class EventBuffer {
	_emitter: EventEmitter;
	_event: string | symbol;
	_collector: (...args: any) => void;
	_buffer: any;
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
