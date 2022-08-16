import { EventEmitter } from "./emitter.ts"

/** 读取命令时，每次读取多少字节 */
const CONN_READ_BYTES = 4096

/** 地址信息 */
export interface IAddr {
	hostname: string
	port: number
	transport: 'tcp' | 'udp'
}

/** FTP连接 */
export class FTPConnection extends EventEmitter<{
	command: (cmd: string, opt: string) => any
	error: (err: Error) => any
}>{
	#conn: Deno.Conn
	#server: FTPServer

	constructor(conn: Deno.Conn, server: FTPServer) {
		super()
		this.#conn = conn
		this.#server = server

		setTimeout(async () => {
			try {
				//发送ready信息
				await this.send(220, 'FTP server (YizhiFTP) ready')
				//开始接受消息
				this.#resolve()
			} catch (err) {
				this.fire('error', err)
			}
		}, 10);
	}

	/** 服务器信息 */
	public get server() {
		return this.#server
	}

	/** 本地地址 */
	public get localAddr() {
		return this.#conn.localAddr as IAddr
	}

	/** 远程地址 */
	public get remoteAddr() {
		return this.#conn.remoteAddr as IAddr
	}

	/**
	 * 相应字符串
	 * @param text 相应的字符串
	 * @param line 是否追加换行
	 */
	public write(text: string, line: boolean = true) {
		const resp = text + (line ? '\r\n' : '')
		return this.#conn.write(new TextEncoder().encode(resp))
	}

	/**
	 * 发送数据
	 * @param code 状态码
	 * @param text 文本
	 */
	public send(code: number, text: string) {
		return this.write(`${code} ${text}`)
	}

	//处理请求
	async #resolve() {
		while (true) {
			try {
				const text = await this.#readCommand()
				const cmd = this.#parseCommand(text)
				if (!cmd) continue

				await this.fire('command', cmd.name, cmd.opt)
			} catch (err) {
				this.fire('error', err)
				break
			}
		}
	}

	//解析命令
	#parseCommand(text: string) {
		// const items: Array<string> = []

		// let buffer = ''
		// for (let i = 0; i < text.length; ++i) {
		// 	//转义字符
		// 	if (text[i] == '\\') {
		// 		buffer += text[++i]
		// 	}
		// 	//空格
		// 	else if (text[i] == ' ') {
		// 		while (text[i + 1] == ' ') ++i
		// 		items.push(buffer)
		// 		buffer = ''
		// 		continue
		// 	}
		// 	//继续
		// 	else buffer += text[i]
		// }
		// if (buffer.length) items.push(buffer)

		// if (!items.length) return null

		// return new FTPCommand(items[0].toLowerCase(), items.slice(1))

		let cmd = ''
		let arg = ''

		let index = text.indexOf(' ')
		if (index > 0) {
			cmd = text.substring(0, index)
			arg = text.substring(index + 1)
		}
		else {
			cmd = text
		}
		return { name: cmd.toLowerCase(), opt: arg }
	}

	//读取命令
	async #readCommand() {
		//读取内容
		const content: Array<Uint8Array> = []
		const size: Array<number> = []
		while (true) {
			//读取内容
			const buffer = new Uint8Array(CONN_READ_BYTES)
			const bytes = await this.#conn.read(buffer)
			content.push(buffer)
			size.push(bytes ?? 0)

			//检查是否结束
			if (!bytes) break							//EOF
			if (bytes > 1) {
				if (buffer[bytes - 2] == 13 && buffer[bytes - 1] == 10) break			//\r\n
			}
			else if (bytes == 1) {
				const prev = content[content.length - 2]
				if (prev && prev[prev.length - 1] == 13 && buffer[bytes - 1] == 10) break		//上一个是\r当前是\n
			}
		}

		//将内容进行组合成字符串
		const result = new Uint8Array(size.reduce((prev, cur) => prev + cur, 0))
		let base = 0
		content.forEach((item, index) => {
			for (let i = 0; i < size[index]; ++i) {
				result[base + i] = item[i]
			}
			base += CONN_READ_BYTES
		})
		const command = new TextDecoder().decode(result).trim()

		return command
	}
}

/** FTP服务器 */
export class FTPServer extends EventEmitter<{
	listen: () => any
	connection: (conn: FTPConnection) => any
	error: (err: Error) => any
}> {
	constructor() {
		super()
	}

	listen(option: Deno.ListenOptions) {
		//开始监听
		let server: Deno.Listener
		try {
			server = Deno.listen(option)
		} catch (err) {
			this.fire('error', err)
			return
		}
		this.fire('listen')

		//创建一个函数用于接收请求
		const accept = async () => {
			for await (const _conn of server) {
				try {
					const conn = new FTPConnection(_conn, this)
					this.fire('connection', conn)
				} catch (err) {
					this.fire('error', err)
				}
			}
		}
		accept()
	}
}