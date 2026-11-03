const fs = require('fs');
const path = require('path');
const { warn } = require('./Console');

const CONFIG_ROOT = process.env.CONFIG_DIR
    ? path.resolve(process.env.CONFIG_DIR)
    : path.resolve(__dirname, '../../config');
const ECHO_DIR = path.join(CONFIG_ROOT, 'echo');
const SHOP_DIR = path.join(CONFIG_ROOT, 'shop');
const SPECIES_DIR = path.join(ECHO_DIR, 'species');

const DEFAULT_TIERS = {
    'Echo Fragments': { singular: 'Echo Fragment', breakChance: 0.5 },
    'Echo Shards': { singular: 'Echo Shard', breakChance: 0.25 },
    'Echo Cores': { singular: 'Echo Core', breakChance: 0.1 }
};

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
        if (err.code !== 'ENOENT') warn(`Config: could not read ${file}: ${err.message}`);
        return fallback;
    }
}

// Every ".json" file in a directory, keyed by file name without the extension.
function readJsonDirectory(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(entry => entry.isFile() && /\.json$/i.test(entry.name))
        .map(entry => {
            const data = readJson(path.join(dir, entry.name), null);
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                warn(`Config: ${path.join(dir, entry.name)} must contain a JSON object; skipping.`);
                return null;
            }
            return { name: entry.name.replace(/\.json$/i, ''), data };
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
}

function readSubdirectories(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    } catch {
        return [];
    }
}

function getTiers() {
    const configured = readJson(path.join(ECHO_DIR, 'tiers.json'), null);
    const source = configured && typeof configured === 'object' ? configured : DEFAULT_TIERS;
    const tiers = [];
    for (const [folder, settings] of Object.entries(source)) {
        const chance = Number(settings?.breakChance);
        tiers.push({
            folder,
            singular: settings?.singular || folder,
            breakChance: Number.isFinite(chance) ? Math.min(1, Math.max(0, chance)) : 0
        });
    }
    return tiers;
}

function getTier(folderOrSingular) {
    const wanted = String(folderOrSingular || '').toLowerCase();
    return getTiers().find(t => t.folder.toLowerCase() === wanted || t.singular.toLowerCase() === wanted) || null;
}

function getAttributeNames() {
    const list = readJson(path.join(ECHO_DIR, 'attributes.json'), []);
    return Array.isArray(list) ? list.map(String) : [];
}

// Echo definitions for one tier folder: [{ name, tier, description, attributes }]
function getEchoesForTier(tier) {
    return readJsonDirectory(path.join(ECHO_DIR, tier.folder)).map(({ name, data }) => ({
        name,
        tier: tier.folder,
        description: typeof data.description === 'string' ? data.description : '',
        attributes: data.attributes && typeof data.attributes === 'object' ? data.attributes : {}
    }));
}

function getAllEchoes() {
    return getTiers().flatMap(getEchoesForTier);
}

function getEcho(tierName, name) {
    const tier = getTier(tierName);
    if (!tier) return null;
    return getEchoesForTier(tier).find(e => e.name.toLowerCase() === String(name || '').toLowerCase()) || null;
}

function getSpecies() {
    return readJsonDirectory(SPECIES_DIR)
        .filter(({ data }) => data.enabled !== false)
        .map(({ name, data }) => ({ name, description: typeof data.description === 'string' ? data.description : '' }));
}

function findSpecies(name) {
    const wanted = String(name || '').trim().toLowerCase();
    return getSpecies().find(s => s.name.toLowerCase() === wanted) || null;
}

// Shop items live in config/shop/<Category>/<Item>.json; loose files in config/shop use "General".
function getShopItems() {
    const items = [];
    const add = (category, { name, data }) => {
        const price = Number(data.price);
        if (!Number.isSafeInteger(price) || price < 0) {
            warn(`Config: shop item "${name}" has an invalid price; skipping.`);
            return;
        }
        const echo = data.echo && typeof data.echo === 'object' ? data.echo : null;
        if (echo && !getEcho(echo.tier, echo.name)) {
            warn(`Config: shop item "${name}" references an unknown Echo; skipping.`);
            return;
        }
        items.push({
            id: `${category}/${name}`,
            name,
            category,
            price,
            description: typeof data.description === 'string' ? data.description : '',
            enabled: data.enabled !== false,
            echo: echo ? { tier: getTier(echo.tier).folder, name: echo.name } : null
        });
    };
    readJsonDirectory(SHOP_DIR).forEach(file => add('General', file));
    for (const category of readSubdirectories(SHOP_DIR)) {
        readJsonDirectory(path.join(SHOP_DIR, category)).forEach(file => add(category, file));
    }
    return items.filter(item => item.enabled);
}

function getShopItem(id) {
    return getShopItems().find(item => item.id === id) || null;
}

module.exports = {
    CONFIG_ROOT,
    readJson,
    readJsonDirectory,
    getTiers,
    getTier,
    getAttributeNames,
    getEchoesForTier,
    getAllEchoes,
    getEcho,
    getSpecies,
    findSpecies,
    getShopItems,
    getShopItem
};
