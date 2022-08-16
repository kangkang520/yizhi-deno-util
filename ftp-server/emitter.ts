
/** 事件处理 */
export class EventEmitter<E extends { [P in string]: (...args: any) => any }> {
	#listeners: any = {}

	/**
	 * 监听事件
	 * @param evt 事件名称
	 * @param callback 回调函数
	 */
	public on<_E extends keyof E>(evt: _E, callback: E[_E]) {
		if (!this.#listeners[evt]) this.#listeners[evt] = []
		this.#listeners[evt].push(callback)
	}

	/**
	 * 取消监听
	 * @param evt 事件名称
	 * @param callback 回调函数，如果没有传递则移除所有事件
	 */
	public off<_E extends keyof E>(evt: _E, callback?: E[_E]) {
		if (!this.#listeners[evt]) return
		if (!callback) delete this.#listeners[evt]
		else this.#listeners[evt] = this.#listeners[evt].filter((f: any) => f != callback)
	}

	/**
	 * 单次监听
	 * @param evt 事件名称
	 * @param callback 回调函数
	 */
	public once<_E extends keyof E>(evt: _E, callback: E[_E]) {
		if (!this.#listeners[evt]) this.#listeners[evt] = []
		const cb = (...args: any) => {
			this.#listeners[evt] = this.#listeners[evt].filter((f: any) => f != callback)
			callback(args)
		}
		this.#listeners[evt].push(cb)
	}

	/**
	 * 触发事件
	 * @param evt 事件名称
	 * @param args 参数列表
	 */
	public fire<_E extends keyof E>(evt: _E, ...args: Parameters<E[_E]>): Promise<any> {
		if (!this.#listeners[evt]) return Promise.resolve()
		return Promise.all(this.#listeners[evt].map((f: any) => f(...args as any)))
	}
}