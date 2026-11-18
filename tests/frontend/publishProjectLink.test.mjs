import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import vm from 'node:vm';
const require=createRequire(new URL('../../web/frontend/package.json',import.meta.url));
const ts=require('typescript');
for(const file of ['PublishPage','ManualPublishPage'])test(file+'清空文案同时解除旧项目关联',()=>{
 const text=readFileSync(new URL('../../web/frontend/src/components/'+file+'.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile(file+'.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let action;
 function visit(n){if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(ast)==='button'&&n.getText(ast).includes('清空'))action=n.openingElement.attributes.properties.find(a=>a.name?.text==='onClick')?.initializer?.expression;ts.forEachChild(n,visit)}
 visit(ast);assert.ok(action);const code=action.getText(ast);const calls=[];const context={showToast:()=>{}};
 for(const [,name] of code.matchAll(/\b(set\w+)\(/g))context[name]=(...args)=>calls.push([name,...args]);
 vm.runInNewContext('('+code+')()',context);
 assert.ok(calls.some(([name,value])=>name==='setProjectSource'&&value===undefined));
});
