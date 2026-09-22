/**
 * @param {string} value
 */
export function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} releaseName
 */
export function validateReleaseName(releaseName) {
    if (!/^[A-Za-z0-9._-]+$/.test(releaseName)) throw new Error(`Invalid release name: ${releaseName}`);
}
