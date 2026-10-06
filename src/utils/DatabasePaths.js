const fs = require('fs');
const path = require('path');
const { warn } = require('./Console');

const DATA_ROOT = path.resolve(__dirname, '../../data');

function resolveDatabasePath(directoryName, fileName, legacyPath) {
    const targetDirectory = path.join(DATA_ROOT, directoryName);
    const targetPath = path.join(targetDirectory, fileName);
    const legacyAbsolutePath = path.resolve(legacyPath);
    fs.mkdirSync(targetDirectory, { recursive: true });

    const legacyExists = fs.existsSync(legacyAbsolutePath);
    const targetExists = fs.existsSync(targetPath);
    let migrateLegacyFiles = false;

    if (legacyExists && !targetExists) {
        migrateLegacyFiles = true;
    } else if (legacyExists && targetExists && legacyAbsolutePath !== targetPath) {
        warn(`Both legacy and new database files exist; using ${targetPath} and leaving ${legacyAbsolutePath} untouched.`);
    }

    if (migrateLegacyFiles) {
        for (const suffix of ['-wal', '-shm']) {
            const legacySidecar = `${legacyAbsolutePath}${suffix}`;
            const targetSidecar = `${targetPath}${suffix}`;
            if (fs.existsSync(legacySidecar) && !fs.existsSync(targetSidecar)) {
                fs.renameSync(legacySidecar, targetSidecar);
            }
        }
        fs.renameSync(legacyAbsolutePath, targetPath);
    }

    return targetPath;
}

module.exports = { DATA_ROOT, resolveDatabasePath };
