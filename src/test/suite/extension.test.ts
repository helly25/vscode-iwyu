import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import * as iwyu from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

    test('parseCommandLine test', () => {
        assert.deepStrictEqual([], iwyu.parseCommandLine(""));
        assert.deepStrictEqual(["a", "a"], iwyu.parseCommandLine("a a"));
        assert.deepStrictEqual(["b", "b"], iwyu.parseCommandLine(" b b "));
        assert.deepStrictEqual(["c", "c"], iwyu.parseCommandLine("c  c"));
    });

    test('parseCommandLine test quotes', () => {
        assert.deepStrictEqual(["a", "'a a'"], iwyu.parseCommandLine("a 'a a'"));
        assert.deepStrictEqual(["'b 'b", "b'"], iwyu.parseCommandLine("'b 'b b'"));
    });

    test('parseCommandLine test escape', () => {
        assert.deepStrictEqual(["a\\ \\ a"], iwyu.parseCommandLine("a\\ \\ a"));
        assert.deepStrictEqual(["'\"b 'b", "b\""], iwyu.parseCommandLine("'\"b 'b b\""));
        assert.deepStrictEqual(["c", '"\"c\" c'], iwyu.parseCommandLine('c "\"c\" c'));
        assert.deepStrictEqual(['"d "\"\'\"d', "d' d"], iwyu.parseCommandLine('"d "\"\'\"d d\' d'));
        assert.deepStrictEqual(['"e "\'\"e e\'', "e"], iwyu.parseCommandLine('"e "\'\"e e\' e'));
	});
});
