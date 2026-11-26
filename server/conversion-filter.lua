-- Only embedded raster images and ordinary links survive document conversion.
-- Do not fetch external resources or evaluate source-provided filters/raw code.
local function clean(el)
  if el.attr then el.classes = {}; el.attributes = {} end
  return el
end
function RawBlock(_) return {} end
function RawInline(_) return {} end
function Meta(meta)
  local safe = {}
  for _, key in ipairs({'title', 'author', 'lang', 'date', 'description'}) do
    if meta[key] then safe[key] = pandoc.MetaString(pandoc.utils.stringify(meta[key])) end
  end
  if not safe.title or #pandoc.utils.stringify(safe.title) == 0 then
    safe.title = pandoc.MetaString(pandoc.utils.stringify(meta['langy-fallback-title'] or 'Untitled'))
  end
  if not safe.lang or #pandoc.utils.stringify(safe.lang) == 0 then safe.lang = pandoc.MetaString('und') end
  return safe
end
function Image(el)
  local mime, data = pandoc.mediabag.lookup(el.src)
  if mime and (mime == 'image/png' or mime == 'image/jpeg' or mime == 'image/gif' or mime == 'image/webp') and #data <= 4194304 then return clean(el) end
  return pandoc.Span(el.caption)
end
function Link(el)
  local url = el.target:lower():gsub('%s', '')
  if url:match('^https?://') or url:match('^mailto:') or url:match('^#') then return clean(el) end
  return pandoc.Span(el.content)
end
Header = clean; Span = clean; Div = clean; CodeBlock = clean; Code = clean
Table = clean; Figure = clean

function Pandoc(doc)
  if #pandoc.utils.stringify(doc.blocks):gsub("%s", "") == 0 then error("No readable text") end
  return doc
end
