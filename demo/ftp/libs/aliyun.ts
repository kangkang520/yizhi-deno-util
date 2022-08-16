import * as path from 'https://deno.land/std@0.151.0/path/mod.ts'
import { AliPanDriver, IAliFile } from "./aliyun-driver.ts"
import { CommandResolver, ICommandResolverOption } from "../../../ftp-server/resolver.ts"

interface IBaseCommandResolverOption extends ICommandResolverOption {
	/** 阿里云网盘驱动 */
	driver: AliPanDriver

	/** 
	 * 删除方式，默认batch
	 * 
	 * * `trash`		移到回收站
	 * * `batch`		彻底删除
	 */
	deleteMethod?: 'trash' | 'batch'
}

/**
 * 这是一个基础的FTP文件服务器的简单实现示例，只包含基本的文件目录读写操作
 * 
 * * 用户需实现 pass 方法，用于用户校验
 * 
 * * 次示例中仅实现了部分命令，如果有必要，可以在子类中进行重写，或者添加其他的命令。
 */
export abstract class AliyunDriveCommandResolver extends CommandResolver<IBaseCommandResolverOption> {

	/** 当前用户名 */
	protected _user: string = ''
	/** cwd */
	protected _cwd: string = '/'
	/** pasv命令创建的端口号 */
	protected _tconn: Deno.Conn | null = null

	private _rnfrFile: { file: IAliFile, path: string } | null = null

	/** 删除方式 */
	protected get _deleteMethod() {
		return this._option.deleteMethod ?? 'batch'
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
		try {
			if (!dir) return await this._cmd_error()
			const dirname = this._filename(dir)

			if (!await this._driver.isDirectory(dirname)) {
				await this._send(550, 'Failed to change directory.')
			}
			else {
				this._cwd = dirname
				await this._send(250, 'Directory successfully changed.')
			}
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
		try {
			if (!file) return await this._cmd_error()
			const filename = this._filename(file)

			const size = await this._driver.info(filename).then(res => res.size ?? 0)
			await this._send(213, size + '')
		} catch (err) {
			console.error(err)
			await this._send(550, 'Could not get file size.')
		}
	}

	async list(opt: string) {
		try {
			const files = await this._driver.files(this._cwd)

			//生成文件列表
			let lines: Array<string> = []
			for (const item of files) {
				const link = item.type == 'folder' ? '2' : '1'
				const perm = `${this._user} ${this._user}`
				const size = item.size
				const date = this._formatDate(new Date(item.utime))

				lines.push(`${item.tag} ${link} ${perm} ${size} ${date} ${item.name}`)
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

		} catch (err) {
			console.error(err)

			try {
				if (this._tconn) this._tconn?.close()
			} catch (err) { }

			await this._send(551, 'File listing failed')
		}
	}

	async retr(file: string) {
		try {
			if (!file) return await this._cmd_error()
			const filename = this._filename(file)

			if (this._tconn) {
				const sys = this._driver.getSystemFile(filename)
				if (sys && sys.reader) {
					await this._send(125, 'Data connection already open; Transfer starting')
					await this._tconn.write(await sys.reader())
					this._tconn.close()
					this._tconn = null
					await this._send(226, 'Transfer Complate.')
				}

				else {
					const download = await this._driver.getDownloadURL(filename)

					const res = await fetch(download.url, {
						headers: {
							Referer: 'https://www.aliyundrive.com/',
						}
					})
					const body = res.body!

					await this._send(125, 'Data connection already open; Transfer starting')

					await body.pipeTo(this._tconn.writable)

					// this._tconn.close()

					this._tconn = null
					await this._send(226, 'Transfer Complate.')
				}
			}
			else await this._send(425, 'Use PORT or PASV first.')
		} catch (err) {
			console.error(err)
			await this._send(550, 'No such file or directory')
		}
	}

	async stor(file: string) {
		try {
			if (!file) return await this._cmd_error()
			const filename = this._filename(file)

			if (this._tconn) {
				await this._send(150, 'Opening BINARY mode data connection for file transfer.')
				//预上传
				const upload = await this._driver.preUpload(filename)

				//上传数据
				if (upload.part_info_list.length) {
					await fetch(upload.part_info_list[0].upload_url, {
						method: 'put',
						body: this._tconn.readable,
						headers: {}
					}).then(res => res.text())

					//调用一下完成接口
					await fetch(`https://api.aliyundrive.com/v2/file/complete`, {
						method: 'post',
						headers: {
							'content-type': 'application/json',
							'authorization': `Bearer ${this._driver.accessToken}`,
							'origin': 'https://www.aliyundrive.com',
							'referer': 'https://www.aliyundrive.com/',
							'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.81 Safari/537.36 Edg/104.0.1293.47',
						},
						body: JSON.stringify({
							drive_id: this._driver.driveID,
							file_id: upload.file_id,
							upload_id: upload.upload_id,
						})
					}).then(res => res.json())
				}

				//完成
				await this._send(226, `File received ok.`)
			}
			else {
				this._send(425, 'Use PORT or PASV first.')
			}
		} catch (err) {
			console.error(err)
			await this._send(550, err.message)
		}
	}

	async dele(file: string) {
		try {
			if (!file) return await this._cmd_error()
			const filepath = this._filename(file)

			const info = await this._driver.info(filepath).catch(_ => null)
			if (info?.type != 'file') {
				await this._send(550, 'Not a valid file.')
				return
			}

			await this._driver[this._deleteMethod](filepath)
			await this._send(250, 'Command okay.')
		}
		catch (err) {
			console.error(err)
			await this._send(450, 'Can\'t delete file.')
		}
	}

	async mkd(dir: string) {
		try {
			if (!dir) return await this._cmd_error()
			const dirname = this._filename(dir)

			//已存在
			if (await this._driver.isDirectory(dirname)) {
				await this._send(550, 'Already exists.')
				return
			}

			await this._driver.mkdir(dir)
			await this._send(250, 'Directory created.')
		}
		catch (err) {
			console.error(err)
			await this._send(550, 'Cannot create directory.')
		}


	}

	async rmd(dir: string) {
		try {
			if (!dir) return await this._cmd_error()
			const dirname = this._filename(dir)

			const info = await this._driver.info(dirname).catch(_ => null)
			if (info?.type != 'folder') {
				await this._send(550, 'Not a valid Directory.')
				return
			}

			await this._driver[this._deleteMethod](dirname)
			await this._send(250, 'Command okay.')
		}
		catch (err) {
			console.error(err)
			await this._send(450, 'Can\'t delete Directory.')
		}
	}

	async rnfr(file: string) {
		try {
			if (!file) return await this._cmd_error()
			const filepath = this._filename(file)

			const info = await this._driver.info(filepath).catch(_ => null)
			if (!info) return this._send(550, 'File unavailable')

			this._rnfrFile = { file: info, path: filepath }
			await this._send(350, 'Requested file action pending further information')
		} catch (err) {
			console.error(err)
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
			if (path.dirname(filepath) != path.dirname(this._rnfrFile.path)) return this._send(553, 'Cannot rename file.')
			//名字相同直接成功
			if (filepath == this._rnfrFile.path) return this._send(250, 'Requested file action okay, file renamed.')

			//进行重命名
			await this._driver.rename(this._rnfrFile.file.id, path.basename(filepath))
			return this._send(250, 'Requested file action okay, file renamed.')
		} catch (err) {
			console.error(err)
			return this._send(553, 'Cannot rename file.')
		}
	}
}