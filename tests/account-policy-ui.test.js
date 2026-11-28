import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {accountPolicyFields} from '../src/account-policy.js';

test('opening Settings preserves valid creation defaults and saved limits when the parent form resets',()=>{
  const dom=new JSDOM('<form></form>'),before=globalThis.document;globalThis.document=dom.window.document;
  try{
    const form=document.querySelector('form'),create=accountPolicyFields();form.append(create.root);form.reset();
    assert.deepEqual(create.read(),{safeMode:false,sharedArchive:false,storageLimit:null,expiresAt:null,allowRemember:true,rememberDays:30,sessionHours:24,maxSessions:30,allowDevices:true});
    const edit=accountPolicyFields({safeMode:true,storageLimit:123,allowRemember:false,allowDevices:false,sharedArchive:true,rememberDays:7,sessionHours:3,maxSessions:2});form.append(edit.root);form.reset();
    assert.deepEqual(edit.read(),{safeMode:true,sharedArchive:true,storageLimit:123,expiresAt:null,allowRemember:false,rememberDays:7,sessionHours:3,maxSessions:2,allowDevices:false});
  }finally{globalThis.document=before;dom.window.close();}
});
