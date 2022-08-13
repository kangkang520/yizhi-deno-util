import type { FTPConnection } from "../../mod.ts";
import * as path from 'https://deno.land/std@0.151.0/path/mod.ts'
import { moment } from "https://deno.land/x/deno_ts_moment@0.0.3/mod.ts"
import { copy } from "https://deno.land/std@0.152.0/streams/conversion.ts"
import { AliPanDriver } from "../../aliyun/aliyun.ts";

interface IBaseCommandResolverOption {
	conn: FTPConnection
	driver: AliPanDriver
	debug: boolean
}

/**
 * 这是一个基础的FTP文件服务器的简单实现示例，只包含基本的文件目录读写操作
 * 
 * * 用户需实现 pass 方法，用于用户校验
 * 
 * * 次示例中仅实现了部分命令，如果有必要，可以在子类中进行重写，或者添加其他的命令。
 */
export abstract class AliyunDriveCommandResolver {

	/** 当前用户名 */
	protected _user: string = ''
	/** 选项 */
	protected _option: IBaseCommandResolverOption
	/** pasv命令创建的端口号 */
	protected _tconn: Deno.Conn | null = null

	constructor(option: IBaseCommandResolverOption) {
		this._option = option
	}

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

	protected get _cwd() {
		return this._driver.getCwd()
	}

	protected get _driver() {
		return this._option.driver
	}

	/**
	 * 处理文件名为实际路径
	 * @param name 文件名，一般是命令接收到的文件名
	 */
	protected _filename(name: string) {
		if (name[0] == '/') return name
		else return path.join(this._cwd, name.replace(/^\/+/, ''))
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
	 * 检查文件是否存在
	 * @param filename 文件名，绝对路径
	 */
	protected _fileExists_xxx(filename: string) {
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

	//=====================================================命令===================================

	async feat() {
		await this._writeln([
			'211-Features',
			' SIZE',
			' UTF8',
			' MDTM',
			'211 end',
		].join('\r\n'))
	}

	async user(uname: string) {
		if (!uname) await this._send(530, 'Invalid user name')
		else {
			this._user = uname.trim()
			await this._send(331, 'User name okay, need password')
		}
	}

	/**
	 * pass命令处理
	 * @param pass 密码
	 */
	abstract pass(pass: string): Promise<any>

	async type(type: string) {
		if (type === 'I' || type === 'A') {
			await this._send(200, 'Command okay');
		} else {
			await this._send(202, 'Not supported');
		}
	}

	async opts(opt: string) {
		const [name, val] = opt.toLowerCase().split(/ /)
		switch (name.toLowerCase()) {
			case 'utf8':
				await this._send(200, 'OK')
				break
			default:
				await this._send(451, 'Not supported')
				break
		}
	}

	async syst() {
		await this._send(215, 'UNIX Type: Yizhi FTP Server');
	}


	async pwd() {
		await this._send(257, this._cwd);
	}

	async cwd(dir: string) {
		if (!dir) return await this._cmd_error()
		const dirname = this._filename(dir)

		try {
			await this._driver.cwd(dirname)
			await this._send(250, 'Directory successfully changed.')
		}
		catch (err) {
			console.error(err)
			await this._send(550, 'Failed to change directory.')
		}
	}

	async pasv() {
		//监听一个端口
		const { listener, port } = this._listenRandom(1024)
		//处理连接
		listener.accept().then(conn => this._tconn = conn)

		//返回IP+端口
		const portBase = parseInt(port / 256 as any)
		const portExt = parseInt(port % 256 as any)
		const respAddr = this._option.conn.localAddr.hostname.replace(/\./g, ',') + `,${portBase},${portExt}`

		//响应
		this._send(227, `Entering Passive Mode (${respAddr}).`)
	}

	async size(file: string) {
		if (!file) return await this._cmd_error()
		const fpath = this._filename(file)

		try {
			const size = await this._driver.info(fpath).then(res => res.size ?? 0)
			await this._send(213, size + '')
		} catch (err) {
			await this._send(550, 'Could not get file size.')
		}
	}

	async list(opt: string) {
		const files = await this._driver.files()

		//生成文件列表
		let lines: Array<string> = []
		for (const item of files) {
			const tag = (item.type == 'folder' ? 'drwxrwxr-x' : '-rw-rw-r--')
			const link = item.type == 'folder' ? '2' : '1'
			const perm = `${this._user} ${this._user}`
			const size = item.size
			const date = this._formatDate(new Date(item.utime))

			lines.push(`${tag} ${link} ${perm} ${size} ${date} ${item.name}`)
		}

		//响应数据
		const respData = new TextEncoder().encode(lines.join('\r\n') + '\r\n')

		if (this._tconn) {
			await this._send(150, 'Here comes the directory listing')
			await this._tconn.write(respData)
			this._tconn.close()
			this._tconn = null
			await this._send(226, 'Directory send OK.')
		}
		else await this._send(425, 'Use PORT or PASV first.')
	}

	async retr(file: string) {
	}

	async stor(file: string) {
	}

	async dele(file: string) {
	}

	async mkd(dir: string) {
	}

	async rmd(dir: string) {
	}
}