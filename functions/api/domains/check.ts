import { Env } from '../../types'

export const onRequestPost: PagesFunction<Env> = async (context) => {
    try {
        const { domain } = await context.request.json() as { domain: string }

        const isOnline = await checkDomainStatus(domain)


        return Response.json({
            status: 200,
            message: '检查完成',
            data: { status: isOnline ? '在线' : '离线' }
        })
    } catch (error: any) {
        console.error('域名检查失败:', error)
        return Response.json({
            status: 500,
            message: error instanceof Error ? error.message : '检查失败',
            data: null
        }, { status: 500 })
    }
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