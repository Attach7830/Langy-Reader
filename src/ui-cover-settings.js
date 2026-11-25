import { $, api, message } from './ui.js';
export function coverSearchSettings(){
  let config,loading,epoch=0;
  const keys=['googleKey','amazonId','amazonSecret','amazonTag','amazonVersion','amazonMarket'];
  function fields(){for(const key of keys){const input=$('[data-cover-setting='+key+']');input.value=key==='googleKey'||key==='amazonSecret'?'':config[key]||'';if(key==='googleKey')input.placeholder=config.hasGoogleKey?'Saved Google Books key':'Google Books API key';if(key==='amazonSecret')input.placeholder=config.hasAmazonSecret?'Saved Amazon secret':'Creators API client secret';}}
  function load(){if(config||loading)return loading;const version=epoch;loading=(async()=>{try{const next=await api('/api/settings/covers');if(version!==epoch)return;config=next;$('#cover-provider-controls').hidden=!next.configurable;$('#cover-provider-managed').hidden=next.configurable;if(next.configurable){const market=$('[data-cover-setting=amazonMarket]');market.replaceChildren(...next.markets.map((value)=>new Option(value,value)));fields();}}catch(error){message('#cover-provider-status',error.message);}finally{if(version===epoch)loading=undefined;}})();return loading;}
  async function save(extra={}){if(loading)await loading;if(!config?.configurable)return;const body={...Object.fromEntries(keys.map((key)=>[key,$('[data-cover-setting='+key+']').value])),...extra};
    const changed=body.googleKey||body.amazonSecret||['amazonId','amazonTag','amazonVersion','amazonMarket'].some((key)=>body[key]!==config[key])||extra.clearGoogle||extra.clearAmazon;
    if(!changed)return;config=await api('/api/settings/covers',{method:'PUT',body});fields();message('#cover-provider-status','Cover search connection saved.');}
  $('#cover-provider-save').addEventListener('click',async(event)=>{event.target.disabled=true;try{await save();}catch(error){message('#cover-provider-status',error.message);}finally{event.target.disabled=false;}});
  for(const[key,button]of[['clearGoogle','#cover-google-clear'],['clearAmazon','#cover-amazon-clear']])$(button).addEventListener('click',async(event)=>{event.target.disabled=true;try{await save({[key]:true});}catch(error){message('#cover-provider-status',error.message);}finally{event.target.disabled=false;}});
  return {load,save,reset(){epoch++;config=loading=undefined;for(const key of keys)if(['googleKey','amazonSecret'].includes(key))$('[data-cover-setting='+key+']').value='';}};
}
