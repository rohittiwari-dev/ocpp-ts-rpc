class Queue {
	_pending: number;
	_concurrency: number;
	_queue: any[];
	constructor() {
		this._pending = 0;
		this._concurrency = Infinity;
		this._queue = [];
	}

	setConcurrency(concurrency: number) {
		this._concurrency = concurrency;
		this._next();
	}

	push(fn: any) {
		return new Promise((resolve, reject) => {
			this._queue.push({
				fn,
				resolve,
				reject,
			});

			this._next();
		});
	}

	async _next() {
		if (this._pending >= this._concurrency) {
			return false;
		}

		const job = this._queue.shift();
		if (!job) {
			return false;
		}

		this._pending++;

		try {
			job.resolve(await job.fn());
		} catch (err) {
			job.reject(err);
		}

		this._pending--;
		this._next();
	}
}

export default Queue;
