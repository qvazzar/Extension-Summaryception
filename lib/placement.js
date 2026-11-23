// Pure injection-placement helpers (no SillyTavern, no DOM).

// SillyTavern 1.19.0 public/script.js:484 (extension_prompt_types)
export const PROMPT_TYPES = Object.freeze({
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
});

// SillyTavern 1.19.0 public/script.js:494 (extension_prompt_roles)
export const PROMPT_ROLES = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

export const POSITIONS = ['before_prompt', 'in_prompt', 'in_chat', 'macro_only'];
export const ROLES = ['system', 'user', 'assistant'];

export const PLACEMENT_DEFAULTS = Object.freeze({
    injectionPosition: 'in_chat',
    injectionDepth: 0,
    injectionRole: 'user',
});

const MAX_DEPTH = 10000;

export function normalizePlacement(settings) {
    const s = settings || {};
    const position = POSITIONS.includes(s.injectionPosition) ? s.injectionPosition : PLACEMENT_DEFAULTS.injectionPosition;
    const role = ROLES.includes(s.injectionRole) ? s.injectionRole : PLACEMENT_DEFAULTS.injectionRole;
    let depth = Number(s.injectionDepth);
    if (!Number.isFinite(depth) || depth < 0) depth = 0;
    depth = Math.min(Math.floor(depth), MAX_DEPTH);
    return { position, depth, role };
}

export function buildInjectionArgs(settings, text) {
    const { position, depth, role } = normalizePlacement(settings);
    if (position === 'macro_only') {
        return {
            value: '',
            position: PROMPT_TYPES.NONE,
            depth: 0,
            scan: false,
            role: PROMPT_ROLES.SYSTEM,
            macroOnly: true,
        };
    }
    const positionMap = {
        before_prompt: PROMPT_TYPES.BEFORE_PROMPT,
        in_prompt: PROMPT_TYPES.IN_PROMPT,
        in_chat: PROMPT_TYPES.IN_CHAT,
    };
    const roleMap = {
        system: PROMPT_ROLES.SYSTEM,
        user: PROMPT_ROLES.USER,
        assistant: PROMPT_ROLES.ASSISTANT,
    };
    return {
        value: typeof text === 'string' && text.length > 0 ? text : '',
        position: positionMap[position],
        depth: position === 'in_chat' ? depth : 0,
        scan: false,
        role: roleMap[role],
        macroOnly: false,
    };
}

export function injectionSignature(args) {
    return JSON.stringify([args.value, args.position, args.depth, args.scan, args.role]);
}
