import { FTPConnection } from "./server.ts"

export interface ICommandResolverOption {
	conn: FTPConnection
	debug: boolean
}

export class CommandResolver<OPT extends ICommandResolverOption> {
	protected _option: OPT

	constructor(option: OPT) {
		this._option = option
	}

	/**
	 * 处理命令
	 * @param cmd 命令
	 * @param opt 命令选项
	 */
	public async resolve(cmd: string, opt: string) {
		const that = this as any
		const fun = that[cmd]
		if (typeof fun == 'function') {
			if (this._option.debug) console.log(`\x1b[32m处理命令: ${cmd} ${opt}\x1b[0m`)
			await fun.bind(this)(opt)
		}
		else {
			if (this._option.debug) await this._option.conn.send(502, 'Command not implemented.')
			console.error(`\x1b[33m未实现的命令: ${cmd} ${opt}\x1b[0m`)
		}
	}

	/**
	 * 写入数据并换行
	 * @param text 要写入的文本
	 */
	protected _writeln(text: string) {
		if (this._option.debug) console.log(text)
		return this._option.conn.write(text)
	}

	/**
	 * 发送消息
	 * @param code 状态码
	 * @param message 消息
	 */
	protected _send(code: number, message: string) {
		return this._option.conn.send(code, message)
	}

	/**
	 * 发送命令错误消息
	 */
	protected _cmd_error() {
		return this._send(501, 'Syntax error.')
	}

	/**
	 * 随机监听一个端口
	 * @param base 最小端口号
	 */
	protected _listenRandom(base: number) {
		base = Math.max(0, base)
		base = Math.min(65535, base)

		const range = 65563 - base;

		const port = parseInt(Math.random() * range + base as any)

		while (true) {
			try {
				const listener = Deno.listen({ port })
				return { port, listener }
			} catch (err) { }
		}
	}

	/**
	 * 日期格式化（用于ls命令）
	 * @param date 日期
	 */
	protected _formatDate(date: Date) {
		const monthes = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']

		const pad = (v: number) => v > 9 ? v : `0${v}`

		return `${monthes[date.getMonth()]} ${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
	}
}