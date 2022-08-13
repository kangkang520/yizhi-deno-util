import { moment } from "https://deno.land/x/deno_ts_moment@0.0.3/mod.ts"
import { Moment } from "https://deno.land/x/deno_ts_moment@0.0.3/moment.d.ts"

export class Cookie {
	constructor(
		public name: string,
		public value: string,
	) { }

	public domain: string | null = null
	public path: string | null = null
	public expires: Moment | null = null
	public httpOnly: boolean = false
}

export class YizhiRequest {

	public readonly cookies: { [k in string]: Array<Cookie> } = {}
	#auth: string | null = null

	#cookieStr(origin: string) {
		const resultItems: Array<string> = []
		// const items = this.cookies[origin]
		// if (!items) return ''
		Object.keys(this.cookies).forEach(origin => {
			this.cookies[origin].forEach(item => {
				//TODO 需要过滤
				resultItems.push(`${item.name}=${item.value}`)
			})
		})
		return resultItems.join('; ')
	}

	public setAuth(auth:string) {
		this.#auth = auth
	}

	public async fetch(url: string | URL, init?: RequestInit) {
		const _url = (typeof url == 'string') ? new URL(url) : url
		const _init = init ?? {}

		// console.log(this.#cookieStr(_url.origin))

		return fetch(_url, {
			..._init,
			headers: {
				..._init.headers ?? {},
				...this.#auth ? { authorization: this.#auth } : {},
				'cookie': this.#cookieStr(_url.origin),
				'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.81 Safari/537.36 Edg/104.0.1293.47',
			}
		}).then(res => {
			//处理set-cookie
			for (const [key, val] of res.headers.entries()) {
				if (key != 'set-cookie') continue
				//读取cookie内容
				const [first, ...rest] = val.split(/;/).map(s => s.trim()).map(s => {
					const index = s.indexOf('=')
					if (index < 0) return { key: s, val: null }
					if (index == 0) return null!
					return { key: s.substring(0, index).trim(), val: s.substring(index + 1).trim() }
				}).filter(s => !!s)

				//生成cookie
				if (!first || !first.val) continue
				const cookie = this.#autoCookie(_url.origin, first.key, first.val)
				rest.forEach(opt => {
					const key = opt.key.toLowerCase()
					if (key == 'path') cookie.path = opt.val
					else if (key == 'domain') cookie.domain = opt.val
					else if (key == 'max-age') cookie.expires = moment().add(parseInt(opt.val ?? ''), 'second')
					else if (key == 'expires') cookie.expires = moment(new Date(opt.val!))
					else if (key == 'httponly') cookie.httpOnly = true
					else if (key == 'path') cookie.path = opt.val
					else if (key == 'path') cookie.path = opt.val
				})
			}
			//原样返回
			return res
		})
	}

	#autoCookie(origin: string, name: string, value: string) {
		if (!this.cookies[origin]) this.cookies[origin] = []
		let cookie = this.cookies[origin].find(c => c.name == name)
		if (!cookie) {
			cookie = new Cookie(name, value)
			this.cookies[origin].push(cookie)
		}
		return cookie
	}

	restoreCookie(data: string) {
		const json = JSON.parse(data)
		Object.keys(json).forEach(origin => {
			if (!this.cookies[origin]) this.cookies[origin] = []
			const items = json[origin] as Array<any>
			items.forEach(({ name, value, expires, ...rest }) => {
				const cookie = this.#autoCookie(origin, name, value)
				if (expires) cookie.expires = moment(expires)
				Object.keys(rest).forEach(k => (cookie as any)[k] = rest[k])
			})
		})
	}

	saveCookie() {
		const res: { [p in string]: Array<any> } = {}
		Object.keys(this.cookies).forEach(key => {
			res[key] = []
			this.cookies[key].forEach(cookie => {
				res[key].push({
					...cookie,
					expires: cookie.expires?.format('YYYY-MM-DD HH:mm:ss') ?? null,
				})
			})
		})

		return JSON.stringify(res, null, '\t')
	}

}
