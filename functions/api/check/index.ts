import type { Env } from '../../types'

interface AlertConfig {
    tg_token: string
    tg_userid: string
    wx_api: string
    wx_token: string
    days: number
}

interface Domain {
    domain: string
    expiry_date: string
    tgsend: number
    st_tgsend: number
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    try {
        // 验证 API Token
        const url = new URL(context.request.url)
        const tokenParam = url.searchParams.get('token')
        const authHeader = context.request.headers.get('Authorization')
        const headerToken = authHeader?.replace('Bearer ', '')

        // 同时支持查询参数和 Bearer Token
        const token = tokenParam || headerToken

        if (!token || token !== context.env.API_TOKEN) {
            return Response.json({
                status: 401,
                message: '未授权访问',
                data: null
            }, { status: 401 })
        }

        // 从请求体中获取域名列表
        const { domains: requestedDomains } = await context.request.json() as { domains: string[] };

        if (!Array.isArray(requestedDomains) || requestedDomains.length === 0) {
            return Response.json({
                status: 400,
                message: '请求参数错误, 需要提供一个包含域名的数组',
                data: null
            }, { status: 400 });
        }

        const { results: configResults } = await context.env.DB.prepare(
            'SELECT * FROM alertcfg LIMIT 1'
        ).all<AlertConfig>()

        if (!configResults.length) {
            console.log('未找到告警配置')
            return Response.json({
                status: 404,
                message: '未找到告警配置',
                data: null
            }, { status: 404 })
        }

        const config = configResults[0]
        console.log('获取到告警配置:', {
            days: config.days,
            has_token: !!config.tg_token,
            has_userid: !!config.tg_userid
        })

        const placeholders = requestedDomains.map(() => '?').join(',');
        const query = `
            SELECT domain, expiry_date, tgsend, st_tgsend
            FROM domains
            WHERE (tgsend = 1 OR st_tgsend = 1) AND domain IN (${placeholders})
        `;
        const { results: domains } = await context.env.DB.prepare(query)
            .bind(...requestedDomains)
            .all<Domain>();

        console.log(`找到 ${domains.length} 个启用通知的域名`)
        const notifiedDomains: any[] = []
        const offlineDomains: Domain[] = []
        const expiringDomains: (Domain & { remainingDays: number })[] = []

        for (const domain of domains) {
            const remainingDays = calculateRemainingDays(domain.expiry_date)
            console.log(`检查域名 ${domain.domain}: 过期时间 ${domain.expiry_date}, 剩余天数 ${remainingDays}`)

            // 检查网站连通性
            const isOnline = await checkDomainStatus(domain.domain)

            // 更新域名状态
            const newStatus = isOnline ? '在线' : '离线'
            await context.env.DB.prepare(
                'UPDATE domains SET status = ? WHERE domain = ?'
            ).bind(newStatus, domain.domain).run()

            if (newStatus === '离线' && domain.st_tgsend === 1) {
                offlineDomains.push(domain)
            }

            // 检查域名是否即将过期
            if (remainingDays <= config.days && domain.tgsend === 1) {
                expiringDomains.push({ ...domain, remainingDays })
            }
        }

        // 统一发送离线通知
        if (offlineDomains.length > 0) {
            const offlineDetails = offlineDomains.map(d => `\`${d.domain}\``).join('\n')
            const message = `*🔔 Domains-Support 通知*\n\n` +
                `⚠️ *域名服务离线告警*\n\n` +
                `以下域名无法访问，请立即检查：\n` +
                `${offlineDetails}\n\n` +
                `⏰ 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`

            try {
                if (config.tg_token && config.tg_userid) {
                    await sendTelegramMessage(config.tg_token, config.tg_userid, message)
                    console.log(`成功发送 ${offlineDomains.length} 个域名的离线通知 (Telegram)`)
                }
                if (config.wx_api && config.wx_token) {
                    await sendWeChatMessage(config.wx_api, config.wx_token, '域名服务离线告警', message)
                    console.log(`成功发送 ${offlineDomains.length} 个域名的离线通知 (WeChat)`)
                }
            } catch (error: any) {
                console.error(`发送离线通知失败:`, error)
            }
        }

        // 统一发送过期通知
        if (expiringDomains.length > 0) {
            const expiringDetails = expiringDomains
                .map(d => `\`${d.domain}\` (还剩 ${d.remainingDays} 天, ${d.expiry_date})`)
                .join('\n')
            const message = `*🔔 Domains-Support 通知*\n\n` +
                `⚠️ *域名即将过期提醒*\n\n` +
                `以下域名即将在 ${config.days} 天内过期，请及时续费：\n` +
                `${expiringDetails}\n\n` +
                `⏰ 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`

            try {
                if (config.tg_token && config.tg_userid) {
                    await sendTelegramMessage(config.tg_token, config.tg_userid, message)
                    console.log(`成功发送 ${expiringDomains.length} 个域名的过期通知 (Telegram)`)
                }
                if (config.wx_api && config.wx_token) {
                    await sendWeChatMessage(config.wx_api, config.wx_token, '域名即将过期提醒', message)
                    console.log(`成功发送 ${expiringDomains.length} 个域名的过期通知 (WeChat)`)
                }
                notifiedDomains.push(...expiringDomains.map(d => ({
                    domain: d.domain,
                    remainingDays: d.remainingDays,
                    expiry_date: d.expiry_date
                })))
            } catch (error: any) {
                console.error(`发送过期通知失败:`, error)
            }
        }


        return Response.json({
            status: 200,
            message: '检查完成',
            data: {
                total_domains: domains.length,
                notified_domains: notifiedDomains
            }
        })
    } catch (error: any) {
        console.error('检查执行失败:', error)
        return Response.json({
            status: 500,
            message: '检查执行失败: ' + (error as Error).message,
            data: null
        }, { status: 500 })
    }
}

// 添加对 GET 方法的支持
export const onRequestGet: PagesFunction<Env> = onRequestPost

function calculateRemainingDays(expiryDate: string): number {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const expiry = new Date(expiryDate)
    expiry.setHours(0, 0, 0, 0)
    const diffTime = expiry.getTime() - today.getTime()
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
    return Math.max(0, diffDays)
}

async function checkDomainStatus(domain: string): Promise<boolean> {
    const tryFetch = async (protocol: 'https' | 'http') => {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                const targetUrl = `${protocol}://${domain}`;
                console.log(`正在尝试通过 ${protocol.toUpperCase()} 协议检查域名: ${targetUrl} (第${attempt}次)`);
                const response = await fetch(targetUrl, {
                    method: 'GET',
                    redirect: 'follow',
                    signal: controller.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    }
                });

                clearTimeout(timeoutId);

                if (response.ok) {
                    console.log(`域名 ${domain} 通过 ${protocol.toUpperCase()} 检查在线`);
                    return true;
                }
                console.log(`域名 ${domain} ${protocol.toUpperCase()} 返回状态码: ${response.status} (第${attempt}次)`);
            } catch (error: any) {
                console.error(`${protocol.toUpperCase()} 检查域名 ${domain} 失败 (第${attempt}次):`, error.name === 'AbortError' ? 'Timeout' : error, '完整错误对象:', error);
            }
        }
        console.log(`域名 ${domain} 通过 ${protocol.toUpperCase()} 的所有检查均失败`);
        return false;
    };

    // 优先尝试 HTTPS
    if (await tryFetch('https')) {
        return true;
    }

    // 如果 HTTPS 失败，则尝试 HTTP
    console.log(`域名 ${domain} 的 HTTPS 检查失败，正在尝试 HTTP...`);
    return await tryFetch('http');
}

async function sendTelegramMessage(token: string, chatId: string, message: string): Promise<void> {
    if (!token || !chatId) {
        throw new Error('Telegram token 或 chat ID 未配置')
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`
    console.log('发送 Telegram 请求:', { url, chatId, messageLength: message.length })

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown',
        }),
    })

    const responseData = await response.json()

    if (!response.ok) {
        console.error('Telegram API 响应错误:', responseData)
        throw new Error(`Failed to send Telegram message: ${response.statusText}, Details: ${JSON.stringify(responseData)}`)
    }

    console.log('Telegram API 响应:', responseData)
}

async function sendWeChatMessage(apiUrl: string, token: string, title: string, text: string): Promise<void> {
    if (!apiUrl || !token) {
        console.log('WeChat API URL 或 token 未配置，跳过发送');
        return;
    }

    console.log('准备发送 WeChat 消息:', { url: apiUrl, title, textLength: text.length });
    const body = `title=${encodeURIComponent(title)}&content=${encodeURIComponent(text)}&token=${encodeURIComponent(token)}`;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body,
        });

        const responseData = await response.text();

        if (!response.ok) {
            console.error('WeChat API 响应错误:', responseData);
        } else {
            console.log('WeChat API 响应:', responseData);
        }
    } catch (error: any) {
        console.error('发送 WeChat 消息失败:', error);
    }
}