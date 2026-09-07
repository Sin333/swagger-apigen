import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, withDefaults } from '../src/config.ts';

describe('config', () => {
    it('DEFAULT_CONFIG has a neutral typePrefix and safe cleanup strategy', () => {
        expect(DEFAULT_CONFIG.typePrefix).toBe('');
        expect(DEFAULT_CONFIG.atomicSwap).toBe(true);
    });

    it('withDefaults merges partial overrides without mutating defaults', () => {
        const merged = withDefaults({ typePrefix: 'Api', useUnsafeRecord: true });

        expect(merged.typePrefix).toBe('Api');
        expect(merged.useUnsafeRecord).toBe(true);
        expect(DEFAULT_CONFIG.typePrefix).toBe('');
    });
});
