import {access, readFile, writeFile, constants} from 'fs-extra'
import {emitPages} from './emitPages'
import {RenderType, SandboxSetup} from './renderers'
import * as path from 'path'
import {parse, DefaultTreeParentNode, DefaultTreeElement, DefaultTreeTextNode} from 'parse5'
import walk from 'walk-parse5'
import {normalizeUrl, protoRegExp} from './FakePromise'

export interface WritePagesOptions {
    /**
     * Path to js-bundle file, try to autodetect from template if empty
     */
    bundle?: string

    /**
     * Array of urls with filenames and queries.
     * @example ['index.html?page=main', 'secondary.html?page=some', 'https://example.com?q=1']
     *
     * Default is 'index.html'
     */
    page?: string[]

    /**
     * Html page template file, if empty - default simple html template used.
     */
    template?: string

    /**
     * Id of main div in templte to which render nodes. If empty - "app" used.
     */
    id?: string

    /**
     * Generated pages destination directory. Default is current working directory.
     */
    output?: string

    /**
     * Js bootstrap code.
     */
    bootstrap?: string

    /**
     * Render engine. Jsdom is default.
     */
    engine?: RenderType

    /**
     * Fallback timeout to prerender page. Used if can't autodetect all async tasks endings. Default is 4000 ms.
     */
    timeout?: number

    /**
     * Setup environment script. Exports function, that receives window sandbox
     */
    setup?: string
}

function defaultTemplate(id: string | void, bundle: string) {
    return `
<html>
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="X-UA-Compatible" content="IE=edge" />
        <title>Prerender</title>
    </head>
    <body>
        <div id="${id || 'app'}"></div>
        <script src="${bundle}"></script>
    </body>
</html>
`
}

function bundleFromTemplate(html: string): {urls: string[], code: string} {
    const acc = {
        code: '',
        urls: [],
    }

    walk(parse(html), (node: DefaultTreeElement) => {
        if (node.tagName !== 'script') return
        for (let attr of node.attrs) {
            if (attr.name === 'src') acc.urls.push(attr.value)
        }
        const child = node.childNodes[0] as DefaultTreeTextNode
        if (!child || child.nodeName !== '#text' || !child.value) return

        acc.code += acc.code + ';\n' + child.value.trim()
    })

    return acc
}

const bundleRegExp = /\.js$/

function interopRequire(module: string): any {
    const data = require(module)
    return data && typeof data === 'object' && data.default ? data.default : data
}

/**
 * Loads template, evals bundle code, wait async tasks and write prerendered pages.
 */
export function writePages(opts: WritePagesOptions): Promise<void> {
    let templatePromise: Promise<string>
    let bundlePromise: Promise<string>
    const cwd = process.cwd()

    if (!opts.template && !opts.bundle) throw new Error(`Need one of template or bundle in config`)
    if (opts.template && !opts.bundle) {
        templatePromise = readFile(opts.template).then(data => data.toString())

        bundlePromise = templatePromise.then(template => {
            const htmlData = bundleFromTemplate(template)
            const bundleFiles = htmlData.urls.map(u => {
                const isGlobal = protoRegExp.test(u)
                const p = new URL(normalizeUrl(u))

                return path.join(cwd, isGlobal ? path.basename(p.pathname) : p.pathname)
            })

            return Promise.all(bundleFiles.map(bundleFile =>
                access(bundleFile, constants.R_OK)
                    .then(() => readFile(bundleFile))
                    .catch(e => {
                        console.warn(e)
                    })
            ))
                .then((data: Buffer[]) => data.filter(Boolean).join(';\n') + ';\n' + htmlData.code)
        })
    } else {
        templatePromise = Promise.resolve(defaultTemplate(opts.id, opts.bundle))
        bundlePromise = readFile(opts.bundle).then(data => data.toString())
    }
    const output = opts.output || cwd

    const setup: SandboxSetup = opts.setup ? interopRequire(opts.setup) : undefined

    return Promise.all([templatePromise, bundlePromise]).then(([template, bundle]) =>
        emitPages({
            engine: opts.engine,
            timeout: opts.timeout,
            page: opts.page,
            bundle,
            template,
            setup,
        })
    )
        .then(pages => pages.map(page =>
            writeFile(path.join(output, page.file), page.data)
                .catch(e => {
                    e.message += '. Page url is ' + page.url
                    throw e
                })
        ))
        .then(() => {})
}
