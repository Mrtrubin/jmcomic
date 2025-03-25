

import plugin from '../../lib/plugins/plugin.js'
import fs from 'fs'
import path from 'path'
import yaml from 'yaml'
import iconv from 'iconv-lite'
import { spawn } from 'child_process'
import http from 'http'

const port = 12580; // 端口
const _path = process.cwd() // 获取当前工作目录
const cacheTime = 10 * 1000; // 漫画缓存时间
const recallTime = 60 * 1000; // 群聊消息撤回时间
const albumList = {}; // 保存已经生成的漫画
const folderPath = path.join(_path, 'plugins', 'jmcomic', 'albums'); // 图片缓存文件夹
const pluginPath = path.join(_path, 'plugins', 'jmcomic'); // 插件路径
const maxDownload = 3; // 最大下载数量
let downList = {}; // 下载列表
let server; // 服务器
let serveUrl; // 服务器地址

// 清空漫画缓存
if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true })

export class jmComic extends plugin {
    constructor() {
        super({
            name: 'JM漫画浏览',
            dsc: '生成JM漫画',
            event: 'message',
            priority: 5000,
            rule: [
                {
                    reg: '^[#/]?jm\\s*\\d+$',
                    fnc: 'jmcomic'
                }
            ]
        })
    }

    async jmcomic(e) {
        const comicId = e.msg.replace(/[#/]?jm/i, '').trim()
        if (!comicId) return e.reply('请输入漫画ID')

        try {
            if (Object.keys(downList).length > maxDownload) {
                return e.reply('下载列表已满，请稍后再试')
            }
            // 有缓存
            if (fs.existsSync(path.join(folderPath, comicId))) {
                // 重新设置缓存时间
                clearTimeout(albumList[comicId])
                albumList[comicId] = this.setClearCacheTime(comicId)
                // 发送链接
                return this.e.reply(`✅使用缓存，请及时查看: ${serveUrl}/${comicId}/index.html`, { recallMsg: cacheTime })
            }

            // 下载漫画
            e.reply('正在下载漫画...', { recallMsg: recallTime })
            if (downList[comicId]) {
                return e.reply('该漫画正在下载中，请稍后再试')
            }
            if (!await this.downloadComic(comicId)) {
                return e.reply('下载漫画失败')
            }

            // 读取文件夹
            let title;
            let folders = await fs.promises.readdir(folderPath)
            for (let folder of folders) {
                if (!albumList[folder]) {
                    title = folder;
                    let newFolder = path.join(folderPath, folder);
                    fs.renameSync(newFolder, path.join(folderPath, comicId));
                    break;
                }
            }

            // 生成网页
            e.reply('正在生成网页...', { recallMsg: recallTime })
            let htmlPath = path.join(pluginPath, 'index.html')
            let htmlContent = fs.readFileSync(htmlPath, 'utf8')
            htmlContent = htmlContent.replace("{{title}}", title)
            htmlContent = htmlContent.replace("{{albumId}}", comicId)
            let comicPath = path.join(folderPath, comicId)
            try {
                let imgFiles = await fs.promises.readdir(comicPath)
                if (!imgFiles.length) {
                    return e.reply('下载漫画失败', { recallMsg: recallTime })
                }

                let imgs = ''
                for (let imgFile of imgFiles) {
                    imgs += `<img src="./${imgFile}" alt="${imgFile}">`
                }
                htmlContent = htmlContent.replace("{{imgs}}", imgs);
                fs.writeFileSync(comicPath + '/index.html', htmlContent, 'utf8')
                albumList[comicId] = this.setClearCacheTime(comicId);
            } catch (err) {
                console.error('读取文件夹失败:', err)
                return e.reply('读取文件夹失败', { recallMsg: recallTime })
            }

            // 开启共享服务器
            if (!server) {
                serveUrl = await this.sharedFolder(folderPath, `/albums`, port)
                if (!serveUrl) return e.reply('服务器开启失败', { recallMsg: recallTime })
            }

            // 发送链接
            this.e.reply(`✅生成完成，请及时查看: ${serveUrl}/${comicId}/index.html`, { recallMsg: cacheTime })
        } catch (err) {
            console.error('加载comic失败:', err)
            return false
        }
    }

    /**
     * @brief 获取本机ip地址
     * @returns ip string ip地址
     */
    async getLocalIP() {
        let response = await fetch('https://qifu-api.baidubce.com/ip/local/geo/v1/district');
        let json = await response.json();
        return json.ip;
    }

    async downloadComic(comicId) {
        downList[comicId] = true
        // 设置 图片缓存文件夹
        let optionData = { dir_rule: { base_dir: folderPath } }
        // 保存到文件
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true })
        }
        const optionPath = path.join(_path, 'plugins', 'jmcomic', 'option.yml')
        const newOptionContent = yaml.stringify(optionData)
        fs.writeFileSync(optionPath, newOptionContent, 'utf8')
        const commandArgs = [comicId, `--option=${optionPath}`]
        const child = spawn('jmcomic', commandArgs)
        let stderr = ''
        child.stdout.on('data', (data) => {
            try {
                let dataStr = process.platform === 'win32' ? iconv.decode(data, 'gbk') : data.toString();
                logger.info(dataStr)
            } catch (error) {
                console.error('处理 stdout 数据时出错:', error)
                delete downList[comicId]
                return false
            }
        })

        child.stderr.on('data', (data) => {
            try {
                let dataStr = process.platform === 'win32' ? iconv.decode(data, 'gbk') : data.toString();
                stderr += dataStr
                console.error(dataStr)
            } catch (error) {
                console.error('处理 stderr 数据时出错:', error)
                delete downList[comicId]
                return false
            }
        })

        await new Promise((resolve, reject) => {
            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`子进程以退出码 ${code} 退出，错误信息: ${stderr}`))
                } else {
                    resolve()
                }
            })

            child.on('error', (err) => {
                reject(err)
                delete downList[comicId]
                return false
            })
        })
        delete downList[comicId]
        return true
    }

    /**
     * @brief 共享文件夹
     * @param folderPath string 文件夹路径
     * @param route string 路由
     * @param port number 端口, 默认为 12580
     * @param endTime number 结束时间, 默认为 3 分钟
     * @param endAction function 结束回调
     * @returns url string 服务器地址
     */
    async sharedFolder(folderPath, route, port = 12580) {
        // console.dir({ folderPath, route, port });
        // 验证函数参数
        if (!folderPath) {
            console.error('folderPath is required');
            return 'folderPath is required';
        }
        if (!route) {
            console.error('route is required');
            return 'route is required';
        } if (port < 1024 || port > 65535) {
            console.error('port is invalid');
            return 'port is invalid';
        }
        // 创建 HTTP 服务器
        server = http.createServer((req, res) => {
            // 判断请求文件夹是不是route
            logger.info('user visit ' + req.url);
            if (req.url.indexOf(route) !== 0) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 not found');
                return;
            }

            // 去除route
            req.url = req.url.substring(route.length);
            // 去除查询语句
            let pathname = req.url.split('?')[0];
            // 获取请求路径
            let filePath = path.join(folderPath, pathname);
            // console.dir({ filePath });
            // 检查文件是否存在
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    // 文件不存在，返回 404
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('File not found');
                    return;
                }

                // 如果是目录，列出文件
                if (stats.isDirectory()) {
                    fs.readdir(filePath, (err, files) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Internal Server Error');
                            return;
                        }

                        // 返回文件列表
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        if (files.length === 0) {
                            res.end('Empty Folder');
                            return;
                        }
                        res.end(`
                        <ul>
                            ${files.map(file => `<li><a href="${route}${path.join(req.url, file)}">${file}</a></li>`).join('')}
                        </ul>
                    `);
                    });
                } else {
                    // 如果是文件，返回文件内容
                    fs.readFile(filePath, (err, data) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Internal Server Error');
                            return;
                        }

                        // 返回文件内容
                        if (pathname.match('\.html$')) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                        } else {
                            res.writeHead(200);
                        }
                        res.end(data);
                    });
                }
            });
        });

        // 启动服务器
        const host = '0.0.0.0';
        let ip = await this.getLocalIP();
        let serverUrl = `http://${ip}:${port}${route}`;
        try {
            server.listen(port, host, () => {
                logger.info(`Server is running on ${port} , view: http://localhost:${port}${route}`);
            });
        } catch (err) {
            console.error('启动服务器失败:', err)
            return false
        }

        return serverUrl;
    }

    setClearCacheTime(comicId) {
        return setTimeout(() => {// 清理缓存
            delete albumList[comicId]
            logger.info('清理缓存:', comicId)
            fs.rmSync(path.join(folderPath, comicId), { recursive: true })
            if (Object.keys(albumList).length === 0) {// 关闭服务器
                server.close()
                server = null
                logger.info('关闭服务器')
            }
        }, cacheTime)
    }
}