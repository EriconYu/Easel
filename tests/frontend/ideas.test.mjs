import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(new URL('../../web/frontend/package.json',import.meta.url));
const ts=require('typescript');
const read=p=>readFileSync(new URL('../../web/frontend/src/'+p,import.meta.url),'utf8');
test('inbox uses selected persona and persistent task, never title-only handoff',()=>{
 const app=read('App.tsx');
 assert.match(read('components/Sidebar.tsx'), /page:\s*'ideas'[^\n]+label:\s*'灵感收件箱'/);
 assert.match(app,/<IdeasPage persona=\{selectedPersona\} onDevelop=\{handleGenerateWorkbench\}/);
 const page=read('components/IdeasPage.tsx');
 assert.match(page,/original_text/);assert.match(page,/fetchIdeaVersions/);
 assert.match(page,/inspiration_references/);
 assert.ok(!page.includes('onUseTopic(it.title)'));
});
test('explicit references are opt-in, cancellable, and use only IDs',()=>{
 const exports={};
 runInNewContext(ts.transpileModule(read('lib/ideas.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:()=>({})});
 const selected=[{idea_id:'one',version_id:'real-version'},{idea_id:'two'}];
 assert.equal(exports.ideaReferences(false,selected).length,0);
 assert.equal(exports.ideaReferences(true,selected).length,2);
 assert.equal(exports.toggleIdeaReference(selected,{idea_id:'two'}).length,1);
 assert.equal(exports.toggleIdeaReference([],{idea_id:'one'}).length,1);
});
