import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext, Script} from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const extract=name=>{
  const start=html.indexOf('function '+name+'(');
  assert.ok(start>=0,name);
  const end=html.indexOf('\n}',start)+2;
  assert.ok(end>start,name);
  return html.slice(start,end);
};
const helper=html.match(/const escapeHtml = .*;/)?.[0]; assert.ok(helper);
const api=runInNewContext([helper,extract('parseCsvLine'),extract('parseConcernNumber'),extract('concernsFromCsv'),'({escapeHtml,parseCsvLine,parseConcernNumber,concernsFromCsv})'].join('\n'));
test('Escapes dangerous HTML from CSV-driven displays',()=>{
 assert.equal(api.escapeHtml('<img src=x onerror=alert(1)>'),'&lt;img src=x onerror=alert(1)&gt;');
 assert.equal(api.escapeHtml('A&B"'), 'A&amp;B&quot;');
 for(const value of ['c.title','c.desc','t','c.label']) assert.ok(html.includes('escapeHtml('+value+')'),value);
});
test('Handles quoted CSV cells and valid concerns',()=>{
 assert.deepEqual(Array.from(api.parseCsvLine('"One, two",3,"hi ""there"""')),['One, two','3','hi "there"']);
 const rows=api.concernsFromCsv('title,controversy,trend,volume\n"One, two",80,-10,32');
 assert.equal(rows[0].title,'One, two');assert.equal(rows[0].trend,-10);
});
test('Rejects unsafe or invalid scores instead of storing zero',()=>{
 for(const v of ['NaN','Infinity','105','<svg/onload=alert(1)>'])assert.throws(()=>api.concernsFromCsv('title,controversy\nTest,'+v));
});
test('Keyboard, deep link, selection and upload paths exist',()=>{
 for(const s of ['id="mainContent"','id="charts"','id="concerns"','href="#charts"','href="#concerns"','label for="range"','aria-pressed="true"','aria-pressed="false"','Number.isFinite(value)','label[for='])assert.ok(html.includes(s),s);
 assert.ok(!html.includes('● live from r/Accenture'));
});

test('Inline app JavaScript compiles without syntax errors',()=>{
 const blocks=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match=>match[1]).filter(source=>source.trim());
 assert.ok(blocks.length,'Inline scripts found');
 for(const source of blocks) assert.doesNotThrow(()=>new Script(source));
});
