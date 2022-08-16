import * as path from 'https://deno.land/std@0.151.0/path/mod.ts'
import { moment } from "https://deno.land/x/deno_ts_moment@0.0.3/mod.ts"
import { copy } from "https://deno.land/std@0.152.0/streams/conversion.ts"
import { CommandResolver, ICommandResolverOption } from "../../../ftp-server/resolver.ts"

interface IBaseCommandResolverOption extends ICommandResolverOption {
	basedir: string
}

/**
 * 这是一个基础的FTP文件服务器的简单实现示例，只包含基本的文件目录读写操作
 * 
 * * 用户需实现 pass 方法，用于用户校验
 * 
 * * 次示例中仅实现了部分命令，如果有必要，可以在子类中进行重写，或者添加其他的命令。
 */
export abstract class BaseCommandResolver extends CommandResolver<IBaseCommandResolverOption> {
	/** 当前用户名 */
	protected _user: string = ''
	/** cwd */
	protected _cwd: string = '/'
	/** pasv命令创建的端口号 */
	protected _tconn: Deno.Conn | null = null

	private _rnfrFile: string | null = null


	/**
	 * 处理文件名为实际路径
	 * @param name 文件名，一般是命令接收到的文件名
	 */
	protected _filename(name: string) {
		if (name[0] == '/') return path.join(this._option.basedir, name.replace(/^\/+/, ''))
		else return path.join(this._option.basedir, this._cwd.replace(/^\/+/, ''), name.replace(/^\/+/, ''))
	}

	/**
	 * 检查文件是否存在
	 * @param filename 文件名，绝对路径
	 */
	protected _fileExists(filename: string) {
		try {
			Deno.statSync(filename)
			return true
		} catch (e) {
			return false
		}
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
			if (Deno.statSync(dirname).isDirectory) {
				this._cwd = (dir[0] == '/') ? dir : path.join(this._cwd, dir)
				await this._send(250, 'Directory successfully changed.')
			}
			else {
				await this._send(550, 'Failed to change directory.')
			}
		}
		catch (err) {
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
			const size = Deno.statSync(fpath).size
			await this._send(213, size + '')
		} catch (err) {
			await this._send(550, 'Could not get file size.')
		}
	}

	async list(opt: string) {
		const root = this._filename(this._cwd)

		//生成文件列表
		let lines: Array<string> = []
		for (const item of Deno.readDirSync(root)) {
			const stat = Deno.statSync(path.join(root, item.name))

			const tag = (item.isDirectory ? 'drwxrwxr-x' : '-rw-rw-r--')
			const link = item.isDirectory ? '2' : '1'
			const perm = `${this._user} ${this._user}`
			const size = stat.size
			const date = this._formatDate(stat.mtime!)

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
		if (!file) return await this._cmd_error()
		const filename = this._filename(file)

		if (this._tconn) {
			await this._send(125, 'Data connection already open; Transfer starting')
			const file = await Deno.open(filename, { read: true })
			await copy(file, this._tconn)
			this._tconn.close()
			this._tconn = null
			await this._send(226, 'Transfer Complate.')
		}
		else await this._send(425, 'Use PORT or PASV first.')
	}

	async stor(file: string) {
		if (!file) return await this._cmd_error()
		const filepath = this._filename(file)

		try {
			if (this._tconn) {
				await this._send(150, 'Opening BINARY mode data connection for file transfer.')
				//开始接收
				const start = moment()
				const total = await copy(this._tconn, await Deno.open(filepath, { write: true, create: true }))
				//计算速度
				const seconds = moment().diff(start, 'second')
				const speed = seconds ? (total / 1024 / seconds).toFixed(3) : 0
				//完成
				await this._send(226, `File received ok.Transfer bytes:${total}Bytes;Average speed is:${speed}KB/s`)
			}
			else {
				this._send(425, 'Use PORT or PASV first.')
			}
		} catch (err) {
			this._send(550, err.message)
		}
	}

	async dele(file: string) {
		if (!file) return await this._cmd_error()
		const filename = this._filename(file)

		if (Deno.statSync(filename).isDirectory) {
			await this._send(550, 'Not a valid file.')
		}
		else {
			try {
				await Deno.remove(filename)
				await this._send(250, 'Command okay.')
			} catch (err) {
				await this._send(450, 'Can\'t delete file.')
			}
		}

	}

	async mkd(dir: string) {
		if (!dir) return await this._cmd_error()
		const dirname = this._filename(dir)

		//已存在
		if (this._fileExists(dirname)) {
			await this._send(550, 'Already exists.')
			return
		}

		try {
			Deno.mkdirSync(dirname)
			await this._send(250, 'Directory created.')
		}
		catch (err) {
			await this._send(550, 'Cannot create directory.')
		}

	}

	async rmd(dir: string) {
		if (!dir) return await this._cmd_error()
		const dirname = this._filename(dir)

		//不是目录
		if (!this._fileExists(dirname) || !Deno.statSync(dirname).isDirectory) {
			await this._send(550, 'Not a valid directory.')
			return
		}

		try {
			Deno.removeSync(dirname)
			await this._send(250, 'Directory removed.')
		}
		catch (err) {
			await this._send(550, 'Cannot remove directory.')
		}

	}

	async rnfr(file: string) {
		if (!file) return await this._cmd_error()
		const filepath = this._filename(file)

		try {
			if (!this._fileExists(file)) return this._send(550, 'File unavailable')

			this._rnfrFile = filepath
			await this._send(350, 'Requested file action pending further information')
		} catch (err) {
			return this._send(550, 'File unavailable')
		}
	}

	async rnto(file: string) {
		try {
			if (!file) return await this._cmd_error()
			const filepath = this._filename(file)
			//必须有原始文件
			if (!this._rnfrFile) return this._send(503, 'Cannot find the file which has to be renamed.')

			//目录必须相同
			if (path.dirname(filepath) != path.dirname(this._rnfrFile)) return this._send(553, 'Cannot rename file.')
			//名字相同直接成功
			if (filepath == this._rnfrFile) return this._send(250, 'Requested file action okay, file renamed.')

			//进行重命名
			await Deno.rename(this._rnfrFile, filepath)
			return this._send(250, 'Requested file action okay, file renamed.')
		} catch (err) {
			return this._send(553, 'Cannot rename file.')
		}
	}
}