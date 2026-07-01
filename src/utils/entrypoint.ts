import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isDirectEntrypoint(metaUrl: string): boolean {
    if (!process.argv[1]) {
        return false;
    }
    try {
        return path.resolve(fileURLToPath(metaUrl)) === path.resolve(process.argv[1]);
    } catch {
        return false;
    }
}
