// __proto__ fix, see: https://github.com/jeff-hykin/deno_proto_shim/blob/master/readme.md
import "https://raw.githubusercontent.com/jeff-hykin/deno_proto_shim/2056dfa77bd58ae826d5deedda1a5020717dda9c/main.js"
import { WASI, init } from "https://esm.sh/@wasmer/wasi";
import { WasmFs } from "https://esm.sh/@wasmer/wasmfs";
import { recursivelyOwnKeysOf } from 'https://esm.sh/gh/jeff-hykin/good-js@1.18.2.0/source/flattened/recursively_own_keys_of.js'
import { isPureObject } from 'https://esm.sh/gh/jeff-hykin/good-js@1.18.2.0/source/flattened/is_pure_object.js'

export class Exit extends Error {
    constructor(code) {
        super(`Process exited with code ${code}`);
        this.code = code;
    }
}

function recursiveFsObjectCallback(fsObject, callback, parent="/") {
    for (const [key, value] of Object.entries(fsObject)) {
        const path = parent + "/" + key
        if (typeof value == 'string' || value instanceof Uint8Array) {
            callback('file', path, value)
        } else {
            callback('dir', path, value)
            recursiveFsObjectCallback(value, callback, path + "/")
        }
    }
}

/**
 * @example
 * ```js
 * import "https://raw.githubusercontent.com/jeff-hykin/deno_proto_shim/2056dfa77bd58ae826d5deedda1a5020717dda9c/main.js"
 * import { WasmFs } from "https://esm.sh/@wasmer/wasmfs";
 * const wasmFs = new WasmFs()
 * wasmFs.fs.mkdirSync("/folder1")
 * wasmFs.fs.writeFileSync("/folder1/file.txt", "Hello World")
 * console.log("wasmerFsToFsObject", wasmerFsToFsObject(wasmFs))
 * ```
 */
export function wasmerFsToFsObject(wasmFs, parentPath="/", decodeASCII=true) {
    const fsObject = {}
    for (let each of wasmFs.fs.readdirSync(parentPath)) {
        const path = parentPath + "/" + each
        const stat = wasmFs.fs.statSync(path)
        if (stat.isFile()) {
            fsObject[each] = wasmFs.fs.readFileSync(path)
            if (decodeASCII) {
                const decoder = new TextDecoder('utf-8', { fatal: true });
                try {
                    fsObject[each] = decoder.decode(fsObject[each])
                } catch (error) {
                    
                }
            }
        } else if (stat.isDirectory()) {
            fsObject[each] = wasmerFsToFsObject(wasmFs, path, decodeASCII)
        }
    }
    return fsObject
}

export const isProxyFs = Symbol('isProxyFs')
/**
 * @example
 * ```js
 * var fs = makeFileSystemObject({
 *     "file.txt": "Hello World",
 *     "folder1": {
 *         "file.txt": "Hello World2",
 *     }
 * })
 * fs.folder1["file.txt"] // Hello World
 * 
 * // below is only for internal use/testing
 * const _wasmFs = fs[isProxyFs]
 * console.log(_wasmFs.fs.readFileSync("/file.txt", "utf-8"))
 * ```
 */
export function makeFileSystemObject(fsObject={}) {
    fsObject = structuredClone(fsObject)
    const wasmFs = new WasmFs()
    // init the filesystem
    recursiveFsObjectCallback(fsObject, (type, path, value) => {
        if (type == 'file') {
            wasmFs.fs.writeFileSync(path, value)
        }
        if (type == 'dir') {
            wasmFs.fs.mkdirSync(path)
        }
    })
    
    const subProxies = {}
    function ensureSubProxy(object, parentPath) {
        if (!subProxies[parentPath]) {
            subProxies[parentPath] = new Proxy(object, {
                ownKeys(original, ...args) {
                    return Reflect.ownKeys(original, ...args)
                },
                getOwnPropertyDescriptor(original, prop) {
                    return Reflect.getOwnPropertyDescriptor(original, prop)
                },
                get(original, key) {
                    if (key == isProxyFs) {
                        return wasmFs
                    }
                    const result = Reflect.get(original, key)
                    if (typeof result == 'string' || result instanceof Uint8Array) {
                        return result
                    } else if (result instanceof Object) {
                        return ensureSubProxy(result, parentPath + "/" + key)
                    }
                    return result // probably undefined
                },
                set(original, key, value) {
                    if (typeof key == 'symbol') {
                        return Reflect.set(original, key, value)
                    }
                    // check for overwrite
                    const existing = original[key]
                    const existingWasDir = existing instanceof Object && !(existing instanceof Uint8Array)
                    if (existingWasDir) {
                        const path = parentPath + "/" + key
                        // remove folder first
                        wasmFs.fs.rmSync(path, { recursive: true, force: true })
                        delete subProxies[path]
                    }

                    // setting a file
                    if (typeof value == 'string' || value instanceof Uint8Array) {
                        // write/overwrite file
                        wasmFs.fs.writeFileSync(parentPath + "/" + key, value)
                    // setting a folder
                    } else {
                        // always an empty dir because we delete it just before now
                        // TODO: there is probably a way to use diffing to potentially make this more efficient
                        const emptyDir = ensureSubProxy(result, parentPath + "/" + key)
                        for (const [key, value] of Object.entries(value)) {
                            // no need to handle the object case of value because the setter will handle it
                            emptyDir[key] = value
                        }
                        // changes on the object would not be reflected in the wasmFs, they'll have to use the proxy
                        // this design choice could be debated
                        Object.freeze(value) // thanks to the proxy above this freeze is recursive
                    }
                    // always set the value, not the proxy-object of the value
                    return Reflect.set(original, key, value)
                },
                deleteProperty(original, key) {
                    wasmFs.fs.rmSync(parentPath + "/" + key, { recursive: true, force: true })
                    Reflect.deleteProperty(original, key)
                },
            })
        }
        return subProxies[parentPath]
    }

    // create a proxy that keeps the wasmFs up to date
    return ensureSubProxy(fsObject, "/")
}