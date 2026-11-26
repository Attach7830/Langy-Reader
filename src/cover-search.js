import { $, api, element, message } from './ui.js';

export function coverSearch(form) {
  let epoch=0;
  $('#find-book-covers').addEventListener('click',async(event)=>{
    const version=++epoch; event.target.disabled=true; $('#book-cover-search-results').replaceChildren();
    message('#book-cover-error','Searching covers…');
    try{
      const provider=$('#book-cover-provider').value;
      const result=await api('/api/covers/search',{method:'POST',body:{provider,title:form.elements.title.value,author:form.elements.author.value}});
      if(version!==epoch)return;
      for(const cover of result.covers){
        const row=element('article','cover-search-card'), image=document.createElement('img');image.src=cover.preview;image.alt=cover.title+' cover';image.loading='lazy';
        const title=element('strong','',cover.title), author=element('span','field-note',cover.author), source=element('a','button quiet small',({amazon:'View Amazon edition',openlibrary:'Open Library edition',google:'Google Books edition'})[cover.provider]||'View edition');source.href=cover.source;source.target='_blank';source.rel='noopener noreferrer';
        row.append(image,title,author,source);
        if(cover.url){const choose=element('button','button secondary small','Use this cover');choose.type='button';choose.addEventListener('click',()=>{form.elements.coverUrl.value=cover.url;form.elements.coverUrl.dispatchEvent(new Event('input',{bubbles:true}));message('#book-cover-error','Cover selected. Save the book to apply it.');});row.append(choose);}
        $('#book-cover-search-results').append(row);
      }
      const status=result.covers.length?provider==='amazon'?'Amazon previews link to their source editions. Choose Open Library, Google Books or your own image URL for a cover saved in Langy.':'Choose the edition that matches your book.':'No cover images found. Try a shorter title or change the author.';
      message('#book-cover-error',[status,result.notice].filter(Boolean).join(' '));
    }catch(error){if(version===epoch)message('#book-cover-error',error.message);}finally{if(version===epoch)event.target.disabled=false;}
  });
  return {reset(){epoch++;$('#find-book-covers').disabled=false;$('#book-cover-search-results').replaceChildren();}};
}
