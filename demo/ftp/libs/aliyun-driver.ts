import * as path from 'https://deno.land/std@0.151.0/path/mod.ts'
import { readerFromStreamReader, readAll } from "https://deno.land/std@0.93.0/io/mod.ts";
import puppeteer, { Protocol, ConsoleMessage, Browser, Page } from "https://deno.land/x/puppeteer@14.1.1/mod.ts"
import 'https://deno.land/x/puppeteer@14.1.1/install.ts'
import { EventEmitter } from '../../../ftp-server/emitter.ts';


const ALI_URLS = {
	urls: {
		LOGIN: `https://www.aliyundrive.com/sign/in`,
		LOGOUT: `https://www.aliyundrive.com/sign/out`,
		HOME: `https://www.aliyundrive.com/drive`,
		QRCODE_GEN: `https://passport.aliyundrive.com/newlogin/qrcode/generate.do`,
		QRCODE_QUERY: `https://passport.aliyundrive.com/newlogin/qrcode/query.do`,
		USER_INFO: `https://api.aliyundrive.com/adrive/v2/user/get`,
	},
	api: {
		GET_RECYCLE_BIN: `https://api.aliyundrive.com/adrive/v2/recyclebin/list`,
		CREATE_FOLDER: `https://api.aliyundrive.com/adrive/v2/file/createWithFolders`,
		PRE_UPLOAD: `https://api.aliyundrive.com/adrive/v2/file/createWithFolders`,
		GET_DOWNLOAD: `https://api.aliyundrive.com/v2/file/get_download_url`,
		MOVE_TO_TRASH: `https://api.aliyundrive.com/v2/recyclebin/trash`,
		DELETE_FILE: `https://api.aliyundrive.com/v3/batch`,
		RENAME_FILE: `https://api.aliyundrive.com/v3/file/update`,
		CLEAR_RECYCLE_BIN: `https://api.aliyundrive.com/v2/recyclebin/clear`,
		GET_STORAGE_INFO: `https://api.aliyundrive.com/adrive/v1/user/driveCapacityDetails`,
		LIST_FILES: `https://api.aliyundrive.com/adrive/v3/file/list`,
	},
	is(url: URL | null, key: keyof typeof this.urls) {
		if (!url) return false
		return url.origin + url.pathname == this.urls[key]
	},
}

export enum SystemFileName {
	ScreenShot = '屏幕截图.png',
	QRCode = '登录二维码.png',
	Control = '控制中心',
}


export interface IBizInfo {
	role: string,
	userData: {
		DingDingRobotUrl: string,
		EncourageDesc: string,
		FeedBackSwitch: boolean,
		FollowingDesc: string,
		ding_ding_robot_url: string,
		encourage_desc: string,
		feed_back_switch: boolean,
		following_desc: string
	},
	isFirstLogin: boolean,
	needLink: boolean,
	loginType: string
	nickName: string
	needRpVerify: boolean,
	avatar: string
	accessToken: string
	userName: string
	userId: string
	defaultDriveId: string
	existLink: Array<string>,
	expiresIn: number,
	expireTime: string
	requestId: string
	dataPinSetup: boolean,
	state: string,
	tokenType: string
	dataPinSaved: boolean,
	refreshToken: string
	status: string
}


export interface IAliFile {
	id: string
	type: 'file' | 'folder'
	name: string
	mtime: string
	utime: string
	size: number
	hash: string | null
	parent: string
	tag: string
	pathname?: string
	reader?: () => Uint8Array | Promise<Uint8Array>
}

export enum QRCodeStatus {
	/** 等待扫码登录 */
	NEW = 'NEW',
	/** 请到手机端确认登录 */
	SCANED = 'SCANED',
	/** 扫码取消 */
	CANCELED = 'CANCELED',
	/** 二维码失效 */
	EXPIRED = 'EXPIRED',
	/** 登录成功 */
	CONFIRMED = 'CONFIRMED',
}

interface IAliPanDriverOption {
	/** 目录时间，单位(秒)， 默认 60*5 */
	cacheTime?: number
	/** 浏览器存储目录，默认 ${HOME}/.aliftp */
	browserDataDir?: string
	/** 浏览器的UserAgent */
	userAgent?: string
	/** 浏览器刷新时间间隔，单位(秒)，默认 10*60 */
	refreshTimeout?: number
}

//获取秒数
function sec() {
	return Date.now() / 1000
}

export class AliPanDriver extends EventEmitter<{
	/** 页面或浏览器错误 */
	error: (err: Error) => any
	/** 页面就绪（已登录，并且网盘主界面已加载） */
	ready: () => any
	/** 页面数据改变 */
	dataChanged: (data: {
		localStorage: Record<string | number, string>
		sessionStorage: Record<string | number, string>
		cookies: Array<Protocol.Network.CookieParam>
	}) => any
	/** 开始加载页面 */
	load: (url: string) => any
	/** 登录状态改变 */
	login: (isLogin: boolean) => any
	/** 浏览器控制台输出 */
	console: (msg: ConsoleMessage) => any
}> {

	#dirCache: { [P in string]: { id: string, time: number } } = {}
	#lastData: { dir: string, files: Array<IAliFile> } | null = null

	//浏览器内容处理
	#biz!: IBizInfo
	#page!: Page
	#isLogin = false
	#qrcode: { data: Uint8Array, status: QRCodeStatus } | null = null
	#view: Uint8Array | null = null
	#pageReady = false
	#pageReadyFuncs: Array<() => any> = []

	#option: IAliPanDriverOption


	constructor(option?: IAliPanDriverOption) {
		super()
		this.#option = {
			...option
		}
	}

	/** 初始化 */
	public async init(): Promise<void> {
		const dataDir = this.#option.browserDataDir ? path.resolve(Deno.cwd(), this.#option.browserDataDir) : path.join(Deno.env.get('HOME')!, '.aliftp')
		//读取，保存系统数据
		const sysdata = (file: string, data?: any) => {
			const filepath = path.join(dataDir, file + '.json')
			if (data === undefined) {
				try {
					return JSON.parse(Deno.readTextFileSync(filepath))
				} catch (err) {
					return null
				}
			}
			else {
				Deno.mkdirSync(path.dirname(filepath), { recursive: true })
				Deno.writeTextFileSync(filepath, JSON.stringify(data))
			}
		}

		const browser = await puppeteer.launch({
			args: ['--no-sandbox'],
			// userDataDir: path.join(home, '.aliftp', 'ChromeData'),
			defaultViewport: { width: 1920, height: 1080 },
		});
		browser.on('error', err => this.fire('error', err))

		this.#page = await browser.newPage();
		this.#page.setUserAgent(this.#option.userAgent || `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.81 Safari/537.36`)
		this.#page.on('error', err => this.fire('error', err))
		this.#page.on('console', msg => this.fire('console', msg))

		//定义一个函数用来保存storage和cookie
		await this.#page.exposeFunction('saveStorage', (storage: { localStorage: any, sessionStorage: any }) => {
			console.log('storage changed')
			sysdata('local_storage', storage.localStorage)
			sysdata('session_storage', storage.sessionStorage)
			this.#page.cookies().then(cookies => {
				sysdata('cookie', cookies)
				this.fire('dataChanged', { ...storage, cookies })
			})
		})

		//恢复storage，同时定时报告storage信息
		await this.#page.evaluateOnNewDocument(function (storages: any, aliurls: any) {
			const win = window as any
			win.ALI_URLS = aliurls
			//监听storage改变
			window.addEventListener('storage', (e: any) => {
				win.saveStorage({ localStorage, sessionStorage })
			})
			//设置localstorage和sessionstorage
			Object.keys(storages).forEach(storage => {
				const data = (storages as any)[storage]
				if (!data) return
				Object.keys(data).forEach(key => {
					win[storage][key] = data[key]
				})
			})
		}, { localStorage: sysdata('local_storage'), sessionStorage: sysdata('session_storage') }, ALI_URLS)

		//恢复cookie
		const cookies = sysdata('cookie')
		if (cookies?.length) await this.#page.setCookie(...cookies)

		//开始登录
		this.login().then(async () => {
			this.#biz = await this.#getBiz()

			//定期清理目录缓存
			const CACHE_LVE_TIME = this.#option.cacheTime ?? 60 * 5
			setInterval(() => {
				Object.keys(this.#dirCache).forEach(key => {
					if (this.#dirCache[key].time + CACHE_LVE_TIME < sec()) delete this.#dirCache[key]
				})
			}, 1000 * 10)

		}).catch(err => console.error(err))
	}

	/** 
	 * access_token
	 * 
	 * null表示没有登录 
	 */
	public get accessToken() {
		return this.#isLogin ? this.#biz?.accessToken ?? null : null
	}

	/** 
	 * drive_id
	 * 
	 * null表示没有登录 
	 */
	public get driveID() {
		return this.#isLogin ? this.#biz.defaultDriveId ?? null : null
	}

	/** 页面地址 */
	private get pageURL() {
		try {
			const u = new URL(this.#page.url())
			if (/^about:blank/.test(u.href)) return null
			return u
		} catch (err) {
			return null
		}
	}

	/**
	 * 登录
	 */
	public async login() {
		return new Promise<void>(async (resolve, reject) => {
			try {
				const page = this.#page

				await page.setRequestInterception(true);
				page.on('request', request => {
					request.continue({
						headers: {
							...request.headers(),
							'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.81 Safari/537.36 Edg/104.0.1293.47'
						}
					})
				});

				page.on('response', async response => {
					const url = new URL(response.url())

					//用户信息获取完成，表示就绪
					if (ALI_URLS.is(url, 'USER_INFO')) {
						this.#pageReady = true
						this.#pageReadyFuncs.forEach(f => f())
						this.#pageReadyFuncs.splice(0)
						this.fire('ready')
					}
					//登录页
					else if (ALI_URLS.is(url, 'LOGIN')) {
						this.#isLogin = false
						this.fire('login', false)
					}
					//登录二维码
					else if (ALI_URLS.is(url, 'QRCODE_GEN')) {
						const qr = JSON.parse(await response.text())

						const cp = Deno.run({
							cmd: ['qrencode', qr.content.data.codeContent!, '-o', '-'],
							stdout: 'piped',
							stdin: 'piped',
							stderr: 'piped',
						})
						const reader = readerFromStreamReader(cp.stdout?.readable.getReader()!)
						this.#qrcode = { data: await readAll(reader), status: QRCodeStatus.NEW }
					}
					//二维码状态
					else if (ALI_URLS.is(url, 'QRCODE_QUERY')) {
						const res = JSON.parse(await response.text())
						const status = res.content.data.qrCodeStatus.toUpperCase() as QRCodeStatus

						if (this.#qrcode) this.#qrcode.status = status
						// console.log(status)

						switch (status) {
							//等待扫码
							case QRCodeStatus.NEW:
								break
							//已经扫码
							case QRCodeStatus.SCANED:
								break
							//过期或取消，重新加载页面
							case QRCodeStatus.EXPIRED:
							case QRCodeStatus.CANCELED:
								load_page()
								break
							//登录完成
							case QRCodeStatus.CONFIRMED:
								break
						}
					}
					//注销
					else if (ALI_URLS.is(url, 'LOGOUT')) {
						load_page()
					}
				});

				let reloadTimeout: number | null = null
				const clearReloadTimeout = () => {
					if (!reloadTimeout) return
					clearTimeout(reloadTimeout)
					reloadTimeout = null
				}

				const load_page = () => {
					//定时器
					clearReloadTimeout()

					const loader = async () => {
						const url = this.pageURL
						if (!url) {
							this.fire('load', ALI_URLS.urls.LOGIN)
							return page.goto(ALI_URLS.urls.LOGIN)
						}
						else if (ALI_URLS.is(url, 'LOGOUT')) {
							this.fire('load', ALI_URLS.urls.LOGIN)
							return page.goto(ALI_URLS.urls.LOGIN)
						}
						else {
							this.fire('load', page.url())
							return page.reload()
						}
					}
					this.#pageReady = false

					loader().then(() => {
						clearReloadTimeout()
						reloadTimeout = setTimeout(() => load_page(), 1000 * (this.#option.refreshTimeout ?? 60 * 10));
					}).catch(err => {
						clearReloadTimeout()
						reloadTimeout = setTimeout(() => load_page(), 10000)
					})
				}

				//定时检测登录
				const loginTimer = setInterval(() => {
					if (ALI_URLS.is(this.pageURL!, 'HOME')) {
						clearInterval(loginTimer)
						this.#isLogin = true
						this.fire('login', true)
						this.#qrcode = null
						resolve()
					}
				}, 1000)

				//打开页面
				load_page()


				//定时截图
				setInterval(async () => {
					this.#view = await this.#page.screenshot({ encoding: 'binary' }) as Uint8Array
				}, 1000)


			} catch (err) {
				reject(err)
			}
		})
	}

	/**
	 * 获取目录下的文件列表
	 * @param dirname 目录路径
	 */
	public async files(dirname: string) {
		//没有登录，返回登录二维码以及屏幕截图
		if (!this.#isLogin) {
			if (dirname == '/') return [this.#systemFiles.screen!, this.#systemFiles.qrcode!].filter(f => !!f)
			return []
		}
		//在控制中心目录下
		if (dirname == `/${SystemFileName.Control}`) return this.#systemFiles.controlFiles

		//其他的表示阿里云盘文件
		this.#checkLogin()
		await this.#waitReady()
		const dirId = await this.#getDirectoryId(dirname)
		if (!dirId) throw new Error(`Directory "${dirname}" Not Exists`)
		const files = await this.#getFiles(dirId, false)
		this.#lastData = { dir: dirname, files }
		this.#setDirCache(files, dirname)

		//根目录的时候加入控制中心
		if (dirname == '/') {
			const recycle = this.#systemFiles.control
			if (recycle) files.unshift(recycle)
		}

		return files
	}

	/**
	 * 获取回收站下的文件
	 */
	public async getRecycleBinFiles() {
		this.#checkLogin()
		await this.#waitReady()

		const files = await this.#page.evaluate(async function (biz: IBizInfo) {
			const files: Array<IAliFile> = []

			let marker = ''
			while (true) {
				const res = await fetch(ALI_URLS.api.GET_RECYCLE_BIN, {
					method: 'post',
					headers: {
						'authorization': `Bearer ${biz.accessToken}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						drive_id: biz.defaultDriveId,
						image_thumbnail_process: "image/resize,w_400/format,jpeg",
						limit: 200,
						order_by: "name",
						order_direction: "ASC",
						video_thumbnail_process: "video/snapshot,t_1000,f_jpg,ar_auto,w_400",
					})
				}).then(res => res.json())

				res.items.forEach((item: any) => {
					files.push({
						id: item.file_id,
						type: item.type,
						name: item.name,
						mtime: item.created_at,
						utime: item.updated_at,
						size: item.size || 0,
						hash: item.content_hash ?? null,
						parent: item.parent_file_id,
						tag: item.type == 'file' ? `-rw-rw-r--` : `drwxrwxr-x`,
					})
				})
				marker = res.next_marker

				if (!marker) break
			}

			return files
		}, this.#biz as any)

		return files
	}

	/**
	 * 获取文件信息
	 * @param pathname 文件路径
	 */
	public async info(pathname: string) {
		this.#checkLogin()
		await this.#waitReady()

		const { pdir, base } = await this.#checkParent(pathname)

		//缓存得有，直接读取
		if (this.#lastData?.dir == pdir) {
			const file = this.#lastData.files.find(f => f.name == base)
			if (file) return file
		}

		const files = await this.files(pdir)
		this.#setDirCache(files, pdir)

		const file = files.find(f => f.name == base)
		if (!file) throw new Error(`Path "${pathname}" Not Exists`)

		return file
	}

	/**
	 * 检测路径是不是目录
	 * @param pathname 路径
	 */
	public async isDirectory(pathname: string) {
		//控制中心
		if (pathname == `/${SystemFileName.Control}`) return true
		//其他的查找
		if (pathname != '/') {
			this.#checkLogin()
			await this.#waitReady()
		}
		const id = await this.#getDirectoryId(pathname)
		return !!id
	}

	/**
	 * 创建目录
	 * @param pathname 路径名称
	 */
	public async mkdir(pathname: string) {
		this.#checkLogin()
		await this.#waitReady()
		const { pdir, base, pdirId } = await this.#checkParent(pathname)

		await this.#page.evaluate(function (biz: IBizInfo, parent, name) {
			return fetch(ALI_URLS.api.CREATE_FOLDER, {
				method: 'post',
				body: JSON.stringify({
					check_name_mode: "refuse",
					drive_id: biz.defaultDriveId,
					name: name,
					parent_file_id: parent,
					type: "folder",

				}),
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${biz.accessToken}`,
				}
			}).then(res => res.json())
		}, this.#biz as any, pdirId, base)
	}

	/**
	 * 预上传
	 * @param pathname 文件路径
	 * @returns 上传信息
	 */
	public async preUpload(pathname: string) {
		this.#checkLogin()
		await this.#waitReady()
		const { pdir, base, pdirId } = await this.#checkParent(pathname)

		//创建文件
		const res = await this.#page.evaluate(function (biz: IBizInfo, parent, name) {
			return fetch(ALI_URLS.api.PRE_UPLOAD, {
				method: 'post',
				body: JSON.stringify({
					check_name_mode: "overwrite",
					// content_hash: hash,
					// content_hash_name: "sha1",
					// content_hash:'da39a3ee5e6b4b0d3255bfef95601890afd80709',
					// content_hash_name: "sha1",
					drive_id: biz.defaultDriveId,
					name: name,
					parent_file_id: parent,
					part_info_list: [{ part_number: 1 }],
					// proof_code: "RmVlZFNldHQ=",
					// proof_version: "v1",
					// size: size,
					type: "file",
				}),
				headers: {
					authorization: `Bearer ${biz.accessToken}`,
					'content-type': 'application/json',
				}
			}).then(res => res.json())
		}, this.#biz as any, pdirId, base)

		return res as {
			parent_file_id: string,
			part_info_list: Array<{
				part_number: 1,
				upload_url: string,
				internal_upload_url: string,
				content_type: string,
			}>,
			upload_id: string,
			rapid_upload: boolean,
			type: string
			file_id: string
			revision_id: string
			domain_id: string
			drive_id: string
			file_name: string
			encrypt_mode: string
			location: string
		}
	}

	/**
	 * 获取下载地址
	 * @param pathname 文件路径
	 * @returns 下载信息
	 */
	public async getDownloadURL(pathname: string) {
		this.#checkLogin()
		await this.#waitReady()

		const file = await this.info(pathname).catch(err => null)
		if (!file) throw new Error(`File ${pathname} not exists`)
		if (file.type != 'file') throw new Error(`${pathname} is not a valid file`)

		const res = await this.#page.evaluate(function (biz: IBizInfo, file: string) {
			return fetch(ALI_URLS.api.GET_DOWNLOAD, {
				method: 'post',
				body: JSON.stringify({ drive_id: biz.defaultDriveId, file_id: file }),
				headers: {
					'authorization': `Bearer ${biz.accessToken}`,
					'content-type': 'application/json',
				}
			}).then(res => res.json())
		}, this.#biz as any, file.id)

		return res as {
			domain_id: string,
			drive_id: string,
			file_id: string,
			revision_id: string,
			method: string,
			url: string,
			internal_url: string,
			expiration: string,
			size: number,
			crc64_hash: string,
			content_hash: string,
			content_hash_name: string,
		}
	}

	/**
	 * 检测是否存在
	 * @param pathname 路径
	 */
	public async exists(pathname: string) {
		this.#checkLogin()
		await this.#waitReady()
		return this.info(pathname).then(v => !!v).catch(e => false)
	}

	/**
	 * 删除文件或目录（移入回收站）
	 * @param pathname 路径
	 */
	public async trash(pathname: string) {
		this.#checkLogin()
		await this.#waitReady()

		const file = await this.info(pathname)
		if (!file) throw new Error(`File ${file} not exists`)

		//删除
		await this.#page.evaluate(function (biz: IBizInfo, id: string) {
			return fetch(ALI_URLS.api.MOVE_TO_TRASH, {
				method: 'post',
				body: JSON.stringify({ drive_id: biz.defaultDriveId, file_id: id }),
				headers: {
					'authorization': `Bearer ${biz.accessToken}`,
					'content-type': 'application/json',
				}
			}).then(res => res.text())
		}, this.#biz as any, file.id)
	}

	/**
	 * 删除文件或目录（彻底删除）
	 * @param pathname 路径
	 */
	public async batch(pathname: string) {
		this.#checkLogin()
		await this.#waitReady()

		const file = await this.info(pathname)
		if (!file) throw new Error(`File ${file} not exists`)

		await this.#page.evaluate(function (biz: IBizInfo, file: IAliFile) {
			fetch(ALI_URLS.api.DELETE_FILE, {
				method: 'post',
				headers: {
					'authorization': `Bearer ${biz.accessToken}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					resource: "file",
					requests: [
						{
							id: file.id,
							method: "POST",
							url: "/file/delete",
							body: {
								drive_id: biz.defaultDriveId,
								file_id: file.id,
							},
						}
					]
				})
			})
		}, this.#biz as any, file as any)
	}

	/**
	 * 重命名文件
	 * @param id 文件ID
	 * @param name 文件名称
	 */
	public async rename(id: string, name: string) {
		this.#checkLogin()
		await this.#waitReady()

		await this.#page.evaluate(function (biz: IBizInfo, id, name) {
			return fetch(ALI_URLS.api.RENAME_FILE, {
				method: 'post',
				headers: {
					'authorization': `Bearer ${biz.accessToken}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					check_name_mode: "refuse",
					drive_id: biz.defaultDriveId,
					file_id: id,
					name: name,
				})
			}).then(res => res.json())
		}, this.#biz as any, id, name)
	}

	/**
	 * 处理系统文件
	 * @param pathname 路径名称
	 */
	public getSystemFile(pathname: string) {
		return this.#systemFiles.all.find(f => f.pathname == pathname) ?? null
	}

	/** 清空回收站 */
	public async clearRecycleBin() {
		this.#checkLogin()
		await this.#waitReady()

		await this.#page.evaluate(function (biz: IBizInfo) {
			return fetch(ALI_URLS.api.CLEAR_RECYCLE_BIN, {
				method: 'post',
				headers: {
					'authorization': `Bearer ${biz.accessToken}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ drive_id: biz.defaultDriveId }),
			}).then(res => res.json())
		}, this.#biz as any)
	}

	/**
	 * 获取空间使用情况
	 */
	public async getSpaceUsage() {
		this.#checkLogin()
		await this.#waitReady()

		const result = await this.#page.evaluate(function (biz: IBizInfo) {
			return fetch(ALI_URLS.api.GET_STORAGE_INFO, {
				method: 'post',
				headers: {
					'authorization': `Bearer ${biz.accessToken}`,
					'content-type': 'application/json',
				},
				body: `{}`
			}).then(res => res.json())
		}, this.#biz as any)

		return { total: result.drive_total_size, used: result.drive_used_size }
	}

	//获取目录ID
	async #getDirectoryId(dir: string): Promise<string | null> {
		if (dir == '/') return 'root'
		if (this.#dirCache[dir]) return this.#dirCache[dir].id

		const pdir = path.dirname(dir)
		const base = path.basename(dir)

		const parentId = await this.#getDirectoryId(pdir)
		if (!parentId) return null
		const dirs = await this.#getFiles(parentId, true)
		this.#setDirCache(dirs, pdir)


		const info = dirs.find(dir => dir.type == 'folder' && dir.name == base)

		if (!info) return null
		return info.id
	}

	//获取系统内建文件
	get #systemFiles() {
		const that = this
		return {
			get screen(): IAliFile | null {
				return that.#view ? {
					id: `system_view`,
					type: 'file',
					name: SystemFileName.ScreenShot,
					mtime: new Date().toISOString(),
					utime: new Date().toISOString(),
					size: that.#view.byteLength,
					hash: '',
					parent: 'root',
					tag: `-r--r--r--`,
					pathname: `/${SystemFileName.ScreenShot}`,
					reader: () => that.#view!,
				} : null
			},
			get qrcode(): IAliFile | null {
				if (that.#isLogin || !that.#qrcode || that.#qrcode.status != QRCodeStatus.NEW) return null
				return {
					id: `system_qrcode`,
					type: 'file',
					name: SystemFileName.QRCode,
					mtime: new Date().toISOString(),
					utime: new Date().toISOString(),
					size: that.#qrcode.data.byteLength,
					hash: '',
					parent: 'root',
					tag: `-r--r--r--`,
					pathname: `/${SystemFileName.QRCode}`,
					reader: () => that.#qrcode?.data!,
				}
			},
			get control(): IAliFile | null {
				if (!that.#isLogin) return null
				return {
					id: `system_manager`,
					type: 'folder',
					name: SystemFileName.Control,
					mtime: new Date().toISOString(),
					utime: new Date().toISOString(),
					size: 0,
					hash: '',
					parent: 'root',
					tag: `dr--r--r--`,
					pathname: `/${SystemFileName.Control}`,
				}
			},
			get controlFiles(): Array<IAliFile> {
				const controlFiles = [
					{
						key: 'logout', name: '注销登录.txt',
						size: () => 8,
						data: () => `已注销当前账号`,
						action: () => that.#page.goto(ALI_URLS.urls.LOGOUT),
					},
					{
						key: 'recycle_clear', name: '清空回收站.txt',
						size: () => 8,
						data: () => `回收站已清空`,
						action: () => that.clearRecycleBin().catch(err => console.error(err)),
					},
					{
						key: 'space', name: '空间情况.txt',
						size: () => 8,
						data: async () => {
							const { used, total } = await that.getSpaceUsage()
							return [
								`总空间大小: ${that.#formatBytes(total)}`,
								`已使用: ${that.#formatBytes(used)}`,
								`剩余空间: ${that.#formatBytes(total - used)}`,
							].join('\n')
						},
						action: () => 0
					},
					{
						key: 'screen', name: '屏幕截图.png',
						size: () => that.#view?.byteLength || 0,
						data: async () => that.#view!,
						action: () => 0
					},
				]
				return controlFiles.map(f => ({
					id: `system_control_${f.key}`,
					type: 'file',
					name: f.name,
					mtime: new Date().toISOString(),
					utime: new Date().toISOString(),
					size: f.size(),
					hash: '',
					parent: 'root',
					tag: `-r--r--r--`,
					pathname: `/${SystemFileName.Control}/${f.name}`,
					reader: async () => {
						f.action()
						const data = await f.data()
						if (typeof data == 'string') return new TextEncoder().encode(data)
						else return data
					},
				}))
			},
			get all() {
				return [this.screen!, this.qrcode!, ...this.controlFiles].filter(f => !!f)
			}
		}
	}

	//等待页面加载完成
	async #waitReady() {
		if (this.#pageReady) return
		return new Promise<void>(resolve => this.#pageReadyFuncs.push(resolve))
	}

	/**
	 * 获取当前目录下的文件列表
	 * @param skipWhenFile 是否在读取到目录的时候跳过，在只获取目录的时候使用
	 */
	async #getFiles(dirId: string, skipWhenFile: boolean) {
		const files = await this.#page.evaluate(async function (dirId: string, skipWhenFile: boolean, biz: IBizInfo) {
			let marker = ''
			const files: Array<IAliFile> = []

			while (true) {
				const res = await fetch(ALI_URLS.api.LIST_FILES, {
					method: 'post',
					body: JSON.stringify({
						all: false,
						drive_id: biz.defaultDriveId,
						fields: "*",
						image_thumbnail_process: "image/resize,w_400/format,jpeg",
						image_url_process: "image/resize,w_1920/format,jpeg",
						limit: 200,
						order_by: "name",
						order_direction: "DESC",
						parent_file_id: dirId,
						url_expire_sec: 1600,
						video_thumbnail_process: "video/snapshot,t_1000,f_jpg,ar_auto,w_300",
						...marker ? { 'marker': marker } : {}
					}),
					headers: {
						authorization: `Bearer ${biz.accessToken}`
					}
				}).then(res => res.json())

				try {
					let finish = false
					res.items.forEach((item: any) => {
						if (!finish && skipWhenFile && item.type == 'file') finish = true
						files.push({
							id: item.file_id,
							type: item.type,
							name: item.name,
							mtime: item.created_at,
							utime: item.updated_at,
							size: item.size || 0,
							hash: item.content_hash ?? null,
							parent: item.parent_file_id,
							tag: item.type == 'file' ? `-rw-rw-r--` : `drwxrwxr-x`,
						})
					})
					if (finish) break
				} catch (err) {
					console.log(JSON.stringify(res))
					throw err
				}


				if (!res.next_marker) break
				else marker = res.next_marker
			}

			return files

		}, dirId, skipWhenFile, this.#biz as any)

		//完成
		return files
	}

	/** 获取biz信息 */
	async #getBiz(): Promise<IBizInfo> {
		const biz: any = {}
		const _biz = await this.#page.evaluate(function () {
			return JSON.parse(localStorage.token)
		})
		Object.keys(_biz).forEach(k => {
			biz[k.replace(/_([a-z])/g, (_, v) => v.toUpperCase())] = _biz[k]
		})

		return biz
	}

	//检测上级目录
	async #checkParent(pathname: string) {
		const pdir = path.dirname(pathname)
		const base = path.basename(pathname)

		const pdirId = await this.#getDirectoryId(pdir)
		if (!pdirId) throw new Error(`Directory "${pdir}" not exists`)

		return { pdir, base, pdirId }
	}

	//设置缓存
	#setDirCache(files: Array<IAliFile>, dirname: string) {
		files.forEach(file => {
			if (file.type != 'folder') return
			const dirpath = path.join(dirname, file.name)
			this.#dirCache[dirpath] = { id: file.id, time: sec() }
		})
	}

	/** 字节格式化 */
	#formatBytes(bytes: number) {
		const unit = ['B', 'KB', 'MB', 'GB', 'TB', 'EB', 'PB']
		let index = 0
		while (bytes > 1024 && index < unit.length - 1) {
			bytes /= 1024
			++index
		}
		return `${bytes.toFixed(2)} ${unit[index]}`
	}

	#checkLogin() {
		if (!this.#isLogin) throw new Error('Need Login first')
	}

}
