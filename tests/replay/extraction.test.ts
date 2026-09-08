import { describe, expect, it } from 'vitest';
import { buildAction } from '../../src/agent/loop.js';
import { applyTransform } from '../../src/replay/inputs.js';
import { compileCapability, type CompileInput, type RecordedStep } from '../../src/agent/recorder.js';
import { observation, control } from '../helpers/fixtures.js';

/**
 * Reading one field out of a composite line.
 *
 * Meridian puts three values in a single status footer --
 * "OPR TELLER1 | BR MAIN-001 | SID 5221CABC" -- and there is no element that
 * holds just the operator. Before this, the model could only point at the whole
 * line and hand the caller a string containing none of the fields it asked for.
 * The `regex` transform already existed in replay; nothing could produce one.
 */
const FOOTER = 'OPR TELLER1 | BR MAIN-001 | 09/03/2026 23:38:07 | SID 5221CABC';

describe('regex extraction', () => {
  describe('replay side', () => {
    it('pulls one field out of a composite line', () => {
      expect(applyTransform(FOOTER, { kind: 'regex', pattern: 'OPR\\s+(\\S+)', group: 1 })).toBe('TELLER1');
      expect(applyTransform(FOOTER, { kind: 'regex', pattern: 'BR\\s+(\\S+)', group: 1 })).toBe('MAIN-001');
    });

    it('fails loudly when the screen no longer matches', () => {
      // Better than returning the whole line: a caller that gets "MAIN-001" today
      // and the entire footer tomorrow has no way to notice.
      expect(() => applyTransform('SIGNED OFF', { kind: 'regex', pattern: 'OPR\\s+(\\S+)', group: 1 })).toThrow(/did not match/);
    });
  });

  describe('record side', () => {
    const footerControl = control({ ref: '1:0', role: 'text', name: 'session footer' });
    const obs = observation([footerControl]);
    const call = (args: Record<string, unknown>) =>
    buildAction({ id: 'call_1', name: 'read_value', args }, obs, ['meridianOperatorPass'], []);

    it('accepts a structural pattern and carries it through', () => {
      const built = call({ ref: '1:0', outputName: 'signedOnOperator', format: 'regex', pattern: 'OPR\\s+(\\S+)', why: 'Read the signed-on operator.' });
      expect(built).toMatchObject({ capture: { name: 'signedOnOperator', format: 'regex', pattern: 'OPR\\s+(\\S+)' } });
    });

    it('rejects a pattern with no capture group', () => {
      // Group 0 would make the transform a no-op and hand back the whole footer.
      const built = call({ ref: '1:0', outputName: 'op', format: 'regex', pattern: 'OPR\\s+\\S+', why: 'x' });
      expect(built).toMatchObject({ error: expect.stringContaining('no capture group') });
    });

    it('treats a non-capturing group as no capture group', () => {
      const built = call({ ref: '1:0', outputName: 'op', format: 'regex', pattern: 'OPR(?:\\s+)\\S+', why: 'x' });
      expect(built).toMatchObject({ error: expect.stringContaining('no capture group') });
    });

    it('rejects a pattern that will not compile', () => {
      const built = call({ ref: '1:0', outputName: 'op', format: 'regex', pattern: 'OPR\\s+((\\S+)', why: 'x' });
      expect(built).toMatchObject({ error: expect.stringContaining('not a valid regular expression') });
    });

    it('refuses a pattern that embeds this run\'s own data', () => {
      // Record-time data caught where the pattern is authored: "OPR (TELLER1)" matches the
      // record it was recorded against and nothing else.
      const withParam = buildAction(
        { id: 'call_1', name: 'read_value', args: { ref: '1:0', outputName: 'op', format: 'regex', pattern: '(103001)-MMKT', why: 'x' } },
        obs,
        [],
        [{ name: 'memberId', value: '103001', type: 'string', sensitivity: 'pii', description: 'member' }],
      );
      expect(withParam).toMatchObject({ error: expect.stringContaining('only ever match this record') });
    });

    it('requires a pattern when the format is regex', () => {
      expect(call({ ref: '1:0', outputName: 'op', format: 'regex', why: 'x' })).toMatchObject({
        error: expect.stringContaining('requires a pattern'),
      });
    });

    it('leaves the other formats alone', () => {
      expect(call({ ref: '1:0', outputName: 'bal', format: 'money', why: 'x' })).toMatchObject({
        capture: { format: 'money' },
      });
    });
  });

  describe('compiled artifact', () => {
    it('compiles a regex capture into a regex transform on the step', () => {
      const footerTarget = {
        description: 'session footer',
        strategies: [{ kind: 'text' as const, text: 'OPR', textMatch: 'contains' as const }],
      };
      const steps: RecordedStep[] = [
        {
          intent: 'Open the sign-on screen',
          action: { kind: 'navigate', url: 'https://example.test/signon' },
          risk: 'safe',
          textBefore: '',
          textAfter: 'OPERATOR SIGN ON',
          urlAfter: 'https://example.test/signon',
          headingsBefore: [],
          headingsAfter: ['OPERATOR SIGN ON'],
          usedSecret: false,
        },
        {
          intent: 'Read the signed-on operator from the session footer.',
          action: { kind: 'readText', target: footerTarget },
          risk: 'safe',
          textBefore: 'MAIN MENU',
          textAfter: 'MAIN MENU',
          urlAfter: 'https://example.test/menu',
          headingsBefore: ['MAIN MENU'],
          headingsAfter: ['MAIN MENU'],
          usedSecret: false,
          capture: { name: 'signedOnOperator', format: 'regex', pattern: 'OPR\\s+(\\S+)', observedValue: 'TELLER1' },
        },
      ];

      const input: CompileInput = {
        id: 'session.sign-on',
        name: 'Sign On',
        summary: 'Sign on and read the operator.',
        description: 'x',
        goal: 'sign on',
        productId: 'meridian-core',
        productVersion: '4.2.1',
        tenantId: 'meridian-core-sandbox',
        baseUrl: 'https://example.test',
        entryUrl: 'https://example.test/signon',
        parameters: [],
        successText: 'MAIN MENU',
        steps,
        provenance: { discoveryRunId: 'discovery-test', model: 'openai:test', modelTurns: 2, transcript: { turns: [] }, recordedBy: 'test', humanInterventions: 0 },
      };

      const cap = compileCapability(input);
      const step = cap.steps.find((st) => st.captureAs === 'signedOnOperator');
      expect(step?.transform).toEqual({ kind: 'regex', pattern: 'OPR\\s+(\\S+)', group: 1 });
      // And the round trip actually produces the field.
      expect(applyTransform(FOOTER, step!.transform!)).toBe('TELLER1');
    });
  });
});
