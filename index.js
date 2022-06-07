require('dotenv').config()
const Queue = require('bull')
const express = require('express')
var app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
const mhtml2html = require('mhtml2html')
const { JSDOM } = require('jsdom')
const IPFS = require('ipfs')
const axios = require('axios').default
const pako = require('pako')

const pdfQueue = new Queue('pdf transcoding', {
    redis: {
        port: 15957,
        host: process.env.URL,
        password: process.env.PASSWORD
    }
})

pdfQueue.process(2, async function (job, done) {
    console.log('jobbing')
    console.log(job.data)
    var filename = `${job.data.guildID}-${job.data.reqUser}.html`
    const Xvfb = require('xvfb')
    const puppeteer = require('puppeteer')

    const mhtml = await toMhtml(job.data.link, job.data.ua, Xvfb, puppeteer)
    const htmldoc = await mhtml2html.convert(mhtml, { parseDOM: (html) => new JSDOM(html) })

    // dev: localhost:8080
    await axios.post('http://localhost:8080/pdfin', {
        link: job.data.link,
        ua: job.data.ua,
        guildID: job.data.guildID,
        channelID: job.data.channelID,
        reqUser: job.data.reqUser,
        file: htmldoc.serialize()
    })

    done()
})

async function toMhtml(link, ua, Xvfb, puppeteer) {
    // const xvfb = new Xvfb({
    //     silent: true,
    //     xvfb_args: ['-screen', '0', '1024x768x24', '-ac']
    // })
    // xvfb.startSync()
    const browser = await puppeteer.launch({
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-infobars',
            '--window-position=0,0',
            '--ignore-certifcate-errors',
            '--ignore-certifcate-errors-spki-list',
            `--user-agent=${ua}`,
            '--disable-features=ImprovedCookieControls',
            `--disable-extensions-except=${process.cwd()}/bypass-paywalls-chrome-master,${process.cwd()}/extension_5_7_5_0`,
            `--load-extension=${process.cwd()}/bypass-paywalls-chrome-master,${process.cwd()}/extension_5_7_5_0`,
            '--no-zygote',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            // '--single-process', // <- this one doesn't works in Windows
            '--disable-gpu',
            '--disable-accelerated-mjpeg-decode',
            '--disable-accelerated-video-decode',
            '--disable-breakpad', // disables crash reporting
            '--disable-client-side-phishing-detection',
            '--disable-default-apps',
            '--disable-features=Translate,AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
            '--disable-popup-blocking',
            '--disable-renderer-backgrounding', // disables tab freezing
            '--disable-sync',
            '--mute-audio',
            '--autoplay-policy=user-gesture-required',
            '--disable-component-update',
            '--disable-domain-reliability',
            '--disable-print-preview',
            '--disable-site-isolation-trials',
            '--disable-speech-api',
            '--disable-web-security',
            '--enable-features=SharedArrayBuffer',
            '--no-default-browser-check',
            '--no-pings',
            '--use-gl=swiftshader',
            '--disable-canvas-aa',
            '--disable-composited-antialiasing',
            '--disable-extensions-http-throttling',
            '--disable-gpu-sandbox',
            '--disable-namespace-sandbox',
            '--disable-seccomp-filter-sandbox',
            '--no-experiments',
            '--disable-renderer-backgrounding',
            // '--display=' + xvfb._display
        ],
        headless: false,
        defaultViewport: null,
        ignoreHTTPSErrors: true
    })
    const page = await browser.newPage()

    await page.waitForTimeout(800) // ext loading time

    page.bringToFront()
    await page.evaluateOnNewDocument(() => {
        delete Object.getPrototypeOf(navigator).webdriver

        Object.defineProperty(navigator, 'plugins', {
            get: function () {
                // this just needs to have `length > 0`, but we could mock the plugins too
                return [1, 2, 3, 4, 5]
            }
        })

        window.navigator.chrome = {
            app: {
                isInstalled: false
            },
            webstore: {
                onInstallStageChanged: {},
                onDownloadProgress: {}
            },
            runtime: {
                PlatformOs: {
                    MAC: 'mac',
                    WIN: 'win',
                    ANDROID: 'android',
                    CROS: 'cros',
                    LINUX: 'linux',
                    OPENBSD: 'openbsd'
                },
                PlatformArch: {
                    ARM: 'arm',
                    X86_32: 'x86-32',
                    X86_64: 'x86-64'
                },
                PlatformNaclArch: {
                    ARM: 'arm',
                    X86_32: 'x86-32',
                    X86_64: 'x86-64'
                },
                RequestUpdateCheckStatus: {
                    THROTTLED: 'throttled',
                    NO_UPDATE: 'no_update',
                    UPDATE_AVAILABLE: 'update_available'
                },
                OnInstalledReason: {
                    INSTALL: 'install',
                    UPDATE: 'update',
                    CHROME_UPDATE: 'chrome_update',
                    SHARED_MODULE_UPDATE: 'shared_module_update'
                },
                OnRestartRequiredReason: {
                    APP_UPDATE: 'app_update',
                    OS_UPDATE: 'os_update',
                    PERIODIC: 'periodic'
                }
            }
        }

        const originalQuery = window.navigator.permissions.query
        return window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters)
        )
    })

    await page.waitForTimeout(1000)
    await Promise.race([page.goto(link).catch(e => void e), new Promise(timer => setTimeout(timer, 10 * 1000))])

    await page.waitForTimeout(1000)

    await page.evaluate(() => window.stop())

    await autoScroll(page)

    console.log('done, exporting')

    const client = await page.target().createCDPSession()
    const { data } = await client.send('Page.captureSnapshot', { format: 'mhtml' })
    await browser.close()
    // xvfb.stopSync()
    return data
}

// https://stackoverflow.com/questions/51529332/puppeteer-scroll-down-until-you-cant-anymore
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve, reject) => {
            var totalHeight = 0
            var distance = 100
            var timer = setInterval(() => {
                var scrollHeight = document.body.scrollHeight
                window.scrollBy(0, distance)
                totalHeight += distance

                if (totalHeight >= scrollHeight) {
                    clearInterval(timer)
                    resolve()
                }
            }, 50) // original 100
        })
    })
}

app.post('/add', async (req, resApp) => {
    pdfQueue.add({ link: req.body.link, ua: req.body.ua, guildID: req.body.guildid, channelID: req.body.channelid, reqUser: req.body.requser })
    resApp.sendStatus(200)
})


var port = process.env.PORT
if (port == null || port === '') {
    port = 8081
}

app.listen(port, () => {
    console.log(`Listening at http://localhost:${port}`)
})



