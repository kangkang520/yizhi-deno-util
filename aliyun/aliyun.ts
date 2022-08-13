import * as base64 from "https://deno.land/std@0.152.0/encoding/base64.ts"
import * as path from 'https://deno.land/std@0.151.0/path/mod.ts'
import { YizhiRequest } from "./request.ts"

const BIZ_FILE = 'alibiz.txt'
const COOKIE_FILE = 'cookie.json'

interface IBizInfo {
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

interface IAliJSON<T> {
	content: {
		data: T,
		status: number,
		success: boolean,
	},
	hasError: boolean,
	success: boolean,
	data: T,
}

type TDirTreeItem = {
	id: string
	name: string
	children: Array<TDirTreeItem> | null			//null表示未加载
}

interface IAliFile {
	id: string
	type: 'file' | 'folder'
	name: string
	mtime: string
	utime: string
	size: number
	hash: string | null
	parent: string
}

export enum QRCodeStatus {
	/** 等待扫码登录 */
	NEW = 'NEW',
	/** 请到手机端确认登录 */
	SCANED = 'SCANED',
	/** 二维码失效 */
	EXPIRED = 'EXPIRED',
	/** 登录成功 */
	CONFIRMED = 'CONFIRMED',
}

export class AliPanDriver {
	#net = new YizhiRequest()
	#biz: IBizInfo | null = null

	#cwd: string = '/'								//当前目录
	#parent: TDirTreeItem							//当前的目录树节点
	#cache: Array<IAliFile> | null = null			//缓存

	#dirTree: TDirTreeItem = { id: 'root', name: '/', children: null }

	constructor() {
		this.#parent = this.#dirTree
	}

	async fetch<T>(url: string | URL, init?: RequestInit): Promise<{
		text: () => Promise<string>,
		json: () => Promise<IAliJSON<T>>,
		apires: () => Promise<T>,
	}> {
		return this.#net.fetch(url, init).then(async res => {
			if (res.status != 401) {
				this.#saveCookie()
				return {
					text: () => res.text(),
					json: () => res.json().then(res => ({
						...res,
						get success() {
							return !this.hasError && this.content.success == true
						},
						get data() {
							return this.content.data
						}
					} as IAliJSON<T>)),
					apires: () => res.json(),
				}
			}
			else {
				return res.json().then(res => {
					console.log(res)
					throw new Error('身份过期')
				})
			}
		})
	}

	public async init() {
		//恢复cookie
		try {
			this.#net.restoreCookie(Deno.readTextFileSync(COOKIE_FILE))
		} catch (err) { }

		//先加载biz
		try {
			const biz = Deno.readTextFileSync(BIZ_FILE)
			this.#biz = this.#parseBiz(biz)
			console.log(this.#biz)
			this.#setAuth(this.#biz.accessToken)
		} catch (err) { }

		if (!this.#biz) await this.login()

	}

	public async login() {
		this.#biz = null
		//生成二维码
		const qrCode = await this.#getLoginQRCode()
		await Deno.run({ cmd: ['qrencode', qrCode.codeContent, '-o', 'xx.png'] }).status()
		//等待登录
		const status = await this.#getQRCodeStatus({ ck: qrCode.ck, t: qrCode.t })
		//二维码失效
		if (status?.qrCodeStatus == QRCodeStatus.EXPIRED) {
			console.error('二维码失效')
			return
		}
		else if (status?.qrCodeStatus == QRCodeStatus.CONFIRMED) {
			this.#biz = this.#parseBiz(status.bizExt)
			this.#setAuth(this.#biz.accessToken)
			// 保存登录信息
			Deno.writeFileSync(BIZ_FILE, new TextEncoder().encode(status.bizExt))
			console.log('登录成功')
		}
	}

	public async cwd(pathname: string) {

		//拆分目录
		let items = pathname.split(/\/+/)
		items[0] = '/'
		items = items.filter(v => !!v)

		let treeItem = this.#dirTree

		for (let i = 1; i < items.length; ++i) {
			//没有children则加载children
			if (!treeItem.children) {
				this.#parent = treeItem
				await this.#getFiles(true, true)
			}
			//从children中查找节点
			let found = false
			for (let j = 0; j < treeItem.children!.length; ++j) {
				const child = treeItem.children![j]
				if (child.name == items[i]) {
					found = true
					treeItem = child
					break
				}
			}

			//没有找到？说明不是目录
			if (!found) throw new Error(`${pathname} Not a Directory`)
		}

		//完成
		this.#cwd = pathname
		this.#parent = treeItem
	}

	public getCwd() {
		return this.#cwd
	}

	public async files() {
		return this.#getFiles(false, true)
	}

	public async info(pathname: string) {
		const basename = path.basename(pathname)

		//查询缓存
		let file = this.#cache?.find(f => f.name == basename) ?? null
		if (file) return file

		//改变目录
		await this.cwd(path.dirname(pathname))

		//获取文件列表
		const files = await this.#getFiles(false, true)
		file = files.find(f => f.name == basename) ?? null
		if (!file) throw new Error(`${pathname} Not Exists`)

		//返回文件
		return file
	}

	/**
	 * 获取当前目录下的文件列表
	 * @param skipWhenFile 是否在读取到目录的时候跳过，在只获取目录的时候使用
	 */
	async #getFiles(skipWhenFile: boolean, updateTree: boolean) {
		let marker = ''
		const files: Array<IAliFile> = []

		while (true) {
			//参数
			const param = {
				"all": false,
				"drive_id": this.#biz?.defaultDriveId,
				"fields": "*",
				"image_thumbnail_process": "image/resize,w_400/format,jpeg",
				"image_url_process": "image/resize,w_1920/format,jpeg",
				"limit": 200,
				"order_by": 'name',
				"order_direction": "DESC",
				"parent_file_id": this.#parent.id,
				"url_expire_sec": 1600,
				"video_thumbnail_process": "video/snapshot,t_0,f_jpg,ar_auto,w_300",
				...marker ? { 'marker': marker } : {}
			}

			//请求
			const res = await this.fetch<{
				items: Array<{
					drive_id: string
					domain_id: string
					file_id: string
					name: string
					type: IAliFile['type']
					created_at: string
					updated_at: string
					hidden: boolean
					starred: boolean
					status: string
					parent_file_id: string
					encrypt_mode: string
					creator_type: string
					creator_id: string
					creator_name: string
					last_modifier_type: string
					last_modifier_id: string
					last_modifier_name: string
					//文件特有
					content_type: string
					file_extension: string
					mime_type: string
					mime_extension: string
					size: number
					crc64_hash: string
					content_hash: string
					content_hash_name: string
					download_url: string
					url: string
					category: string
					punish_flag: number
					revision_id: string
					sync_flag: boolean
					sync_device_flag: boolean
					sync_meta: string
				}>,
				next_marker: string,
				punished_file_count: number,
			}>(`https://api.aliyundrive.com/v2/file/list`, {
				method: 'post',
				body: JSON.stringify(param),
				headers: { 'content-type': 'application/json' },
			}).then(res => res.apires())

			//处理文件
			let finish = false
			res.items.forEach(item => {
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
				})
			})

			if (finish) break

			//处理文件
			if (!res.next_marker) break
			else marker = res.next_marker
		}

		//保存目录树
		if (updateTree) this.#parent.children = files.filter(f => f.type == 'folder').map(f => ({ id: f.id, name: f.name, children: null }))
		this.#cache = files

		//完成
		return files
	}

	#encodeBody = (body: any) => Object.keys(body).map(k => `${k}=${encodeURIComponent(body[k])}`).join('&')

	#saveCookie = () => Deno.writeTextFileSync(COOKIE_FILE, this.#net.saveCookie())

	#parseBiz = (biz: string) => JSON.parse(new TextDecoder('gb2312').decode(base64.decode(biz))).pds_login_result as IBizInfo

	#setAuth = (token: string) => this.#net.setAuth(`Bearer ${token}`)

	#getLoginQRCode = async () => {
		await this.fetch(`https://auth.aliyundrive.com/v2/oauth/authorize?client_id=25dzX3vbYqktVxyX&redirect_uri=https%3A%2F%2Fwww.aliyundrive.com%2Fsign%2Fcallback&response_type=code&login_type=custom&state=%7B%22origin%22%3A%22https%3A%2F%2Fwww.aliyundrive.com%22%7D`)
		const res = await this.fetch<{
			t: number,
			codeContent: string,
			ck: string,
			resultCode: number,
		}>(`https://passport.aliyundrive.com/newlogin/qrcode/generate.do?appName=aliyun_drive&fromSite=52&appName=aliyun_drive&appEntrance=web&_csrf_token=8iPG8rL8zndjoUQhrQnko5&umidToken=27f197668ac305a0a521e32152af7bafdb0ebc6c&isMobile=false&lang=zh_CN&returnUrl=&hsiz=1d3d27ee188453669e48ee140ea0d8e1&fromSite=52&bizParams=&_bx-v=2.0.31`).then(res => res.json())
		if (!res.success) throw new Error('获取二维码失败')
		return res.data
	}

	#getQRCodeStatus = async (body: { [k in string]: string | number }) => {
		while (true) {
			const res = await this.fetch<{
				qrCodeStatus: QRCodeStatus.EXPIRED,
				resultCode: number,
			} | {
				qrCodeStatus: QRCodeStatus.CONFIRMED,
				resultCode: number,
				loginResult: string,
				loginSucResultAction: string,
				st: string,
				loginType: string,
				bizExt: string,
				loginScene: string,
				appEntrance: string,
				smartlock: false
			}>(`https://passport.aliyundrive.com/newlogin/qrcode/query.do?appName=aliyun_drive&fromSite=52&_bx-v=2.0.31`, {
				method: 'post',
				body: this.#encodeBody(body),
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
			}).then(res => res.json())

			if (!res.success) {
				console.error('获取状态失败')
				return null
			}
			if (res.data.qrCodeStatus == QRCodeStatus.CONFIRMED || res.data.qrCodeStatus == QRCodeStatus.EXPIRED) return res.data
			await new Promise(resolve => setTimeout(resolve, 1000))
		}
	}
}


async function test() {
	// const pan = new AliPanDriver()
	// console.log('正在初始化.....')
	// await pan.init()
	// // console.log('正在登录.....')
	// // await pan.login()
	// console.log('正在获取文件.....')
	// await pan.cwd('/test/static')
	// const files = await pan.files()
	// console.log(files)
}


// test()