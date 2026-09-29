/** shell 单引号包裹（内部 ' 转义为 '\''）——远端/本地命令拼接的用户输入一律过这里。 */
export function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
