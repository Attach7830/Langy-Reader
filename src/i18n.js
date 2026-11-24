// Interface text only. Book content, generated explanations and dictionary
// meanings keep their independently selected languages.
const phrases = [
  ['Reading controls', 'Controles de lectura', 'Controles de leitura', '阅读控制'],
  ['Swipe to turn pages', 'Deslizar para pasar de página', 'Deslizar para virar a página', '滑动翻页'],
  ['Tap left or right edge to turn pages', 'Tocar los bordes para pasar de página', 'Tocar nas bordas para virar a página', '点按左右边缘翻页'],
  ['Tap center to toggle full screen', 'Tocar el centro para alternar pantalla completa', 'Tocar no centro para alternar tela cheia', '点按中央切换全屏'],
  ['Downloads', 'Descargas', 'Downloads', '下载'], ['Audio', 'Audio', 'Áudio', '音频'],
  ['Sections', 'Secciones', 'Seções', '章节'], ['Book sections', 'Secciones del libro', 'Seções do livro', '图书章节'],
  ['Chapters and sections', 'Capítulos y secciones', 'Capítulos e seções', '章节和段落'],
  ['Find a chapter or section', 'Buscar un capítulo o sección', 'Buscar um capítulo ou seção', '查找章节'],
  ['Add to download queue', 'Añadir a la cola de descargas', 'Adicionar à fila de downloads', '加入下载队列'],
  ['Cancel download', 'Cancelar descarga', 'Cancelar download', '取消下载'], ['Retry download', 'Reintentar descarga', 'Tentar download novamente', '重试下载'],
  ['Read book', 'Leer libro', 'Ler livro', '阅读图书'], ['Dismiss', 'Quitar de la lista', 'Remover da lista', '从列表移除'],
  ['More reading tools', 'Más herramientas de lectura', 'Mais ferramentas de leitura', '更多阅读工具'],
  ['Library', 'Biblioteca', 'Biblioteca', '书库'], ['About', 'Acerca de', 'Sobre', '关于'], ['Discover', 'Descubrir', 'Descobrir', '发现'],
  ['Checking AI', 'Comprobando IA', 'Verificando IA', '正在检查 AI'], ['Demo use only', 'Solo demostración', 'Apenas demonstração', '仅供演示'],
  ['Dim PDF pages in dark themes', 'Oscurecer PDF con temas oscuros', 'Escurecer PDF em temas escuros', '深色主题下调暗 PDF'],
  ['Add a reading language', 'Añadir un idioma de lectura', 'Adicionar um idioma de leitura', '添加阅读语言'], ['Add a language', 'Añadir un idioma', 'Adicionar um idioma', '添加语言'],
  ['Word help on hover or tap', 'Ayuda al pasar el cursor o tocar', 'Ajuda ao passar o cursor ou tocar', '悬停或点按时显示词语帮助'],
  ['Explain missing synonym entries with AI', 'Explicar entradas sin sinónimos con IA', 'Explicar entradas sem sinônimos com IA', '用 AI 解释缺少同义词的词条'],
  ['Show pinyin above Chinese text', 'Mostrar pinyin sobre el texto chino', 'Mostrar pinyin acima do texto chinês', '在中文上方显示拼音'],
  ['Reset hotkeys', 'Restablecer atajos', 'Restaurar atalhos', '重置快捷键'], ['Provider', 'Proveedor', 'Provedor', '提供方'],
  ['Bundled Ollama', 'Ollama incluido', 'Ollama incluído', '内置 Ollama'], ['Existing Ollama server', 'Servidor Ollama existente', 'Servidor Ollama existente', '现有 Ollama 服务器'],
  ['OpenAI-compatible API', 'API compatible con OpenAI', 'API compatível com OpenAI', '兼容 OpenAI 的 API'], ['API base URL', 'URL base de la API', 'URL base da API', 'API 基础 URL'],
  ['Model', 'Modelo', 'Modelo', '模型'], ['Find available models', 'Buscar modelos disponibles', 'Buscar modelos disponíveis', '查找可用模型'],
  ['Highlight spoken words', 'Resaltar palabras narradas', 'Destacar palavras narradas', '高亮朗读中的词语'], ['Kokoro connection', 'Conexión de Kokoro', 'Conexão do Kokoro', 'Kokoro 连接'],
  ['Voice', 'Voz', 'Voz', '声音'], ['Generation speed', 'Velocidad de generación', 'Velocidade de geração', '生成语速'],
  ['Match Kokoro voices to passage languages', 'Usar voces según el idioma del pasaje', 'Usar vozes conforme o idioma do trecho', '根据段落语言选择 Kokoro 声音'],
  ['English voice', 'Voz en inglés', 'Voz em inglês', '英语声音'], ['Spanish voice', 'Voz en español', 'Voz em espanhol', '西班牙语声音'],
  ['Mandarin voice', 'Voz en mandarín', 'Voz em mandarim', '普通话声音'], ['Portuguese voice', 'Voz en portugués', 'Voz em português', '葡萄牙语声音'],
  ['Remove saved key', 'Eliminar clave guardada', 'Remover chave salva', '删除已保存的密钥'], ['Save and find voices', 'Guardar y buscar voces', 'Salvar e buscar vozes', '保存并查找声音'],
  ['Anna’s Archive mirror', 'Servidor de Anna’s Archive', 'Espelho do Anna’s Archive', 'Anna’s Archive 镜像'],
  ['Anna’s Archive membership key', 'Clave de membresía de Anna’s Archive', 'Chave de associação do Anna’s Archive', 'Anna’s Archive 会员密钥'],
  ['Remove saved membership key', 'Eliminar clave de membresía guardada', 'Remover chave de associação salva', '删除已保存的会员密钥'],
  ['Offer free slow downloads when the fast allowance is reached', 'Ofrecer descargas lentas gratuitas al agotar el cupo rápido', 'Oferecer downloads lentos gratuitos ao atingir o limite rápido', '快速下载额度用完后提供免费慢速下载'],
  ['Retry unavailable downloads every 6 hours', 'Reintentar descargas no disponibles cada 6 horas', 'Tentar downloads indisponíveis a cada 6 horas', '每 6 小时重试不可用的下载'],
  ['OPDS library', 'Biblioteca OPDS', 'Biblioteca OPDS', 'OPDS 书库'], ['Catalog address', 'Dirección del catálogo', 'Endereço do catálogo', '目录地址'],
  ['Copy catalog address', 'Copiar dirección del catálogo', 'Copiar endereço do catálogo', '复制目录地址'], ['Reading progress sync', 'Sincronizar posición de lectura', 'Sincronizar posição de leitura', '阅读进度同步'],
  ['Sync this browser’s reading position', 'Sincronizar la posición de este navegador', 'Sincronizar a posição deste navegador', '同步此浏览器的阅读位置'],
  ['This browser’s device name', 'Nombre de este dispositivo', 'Nome deste dispositivo', '此浏览器的设备名称'],
  ['KOReader Sync server', 'Servidor de sincronización KOReader', 'Servidor de sincronização KOReader', 'KOReader 同步服务器'], ['Copy sync address', 'Copiar dirección de sincronización', 'Copiar endereço de sincronização', '复制同步地址'],
  ['Loading account preferences…', 'Cargando preferencias de la cuenta…', 'Carregando preferências da conta…', '正在加载账户偏好…'],
  ['Import from', 'Importar desde', 'Importar de', '导入来源'], ['Upload file', 'Subir archivo', 'Enviar arquivo', '上传文件'],
  ['Anna’s Archive book link or MD5', 'Enlace del libro o MD5 de Anna’s Archive', 'Link do livro ou MD5 do Anna’s Archive', 'Anna’s Archive 图书链接或 MD5'],
  ['All books use the author entered below', 'Usar el autor indicado para todos los libros', 'Usar o autor indicado para todos os livros', '所有图书使用下方填写的作者'],
  ['Add another book', 'Añadir otro libro', 'Adicionar outro livro', '添加另一本书'], ['Automatic: fast, then free slow download', 'Automático: rápido y luego lento gratuito', 'Automático: rápido e depois lento gratuito', '自动：快速下载，然后免费慢速下载'],
  ['Open book’s slow download options', 'Abrir opciones de descarga lenta', 'Abrir opções de download lento', '打开图书的慢速下载选项'],
  ['Final file download link (optional)', 'Enlace final del archivo (opcional)', 'Link final do arquivo (opcional)', '最终文件下载链接（可选）'],
  ['Configure Anna’s Archive', 'Configurar Anna’s Archive', 'Configurar Anna’s Archive', '配置 Anna’s Archive'], ['Choose an EPUB or PDF', 'Elegir EPUB o PDF', 'Escolher EPUB ou PDF', '选择 EPUB 或 PDF'],
  ['Multiple languages in this book', 'Este libro contiene varios idiomas', 'Este livro contém vários idiomas', '本书包含多种语言'], ['Remove book', 'Eliminar libro', 'Remover livro', '删除图书'],
  ['Reading vocabulary', 'Vocabulario de lectura', 'Vocabulário de leitura', '阅读词汇'], ['Exposures before likely known', 'Exposiciones para considerar conocido', 'Exposições para considerar conhecido', '达到可能掌握所需的接触次数'],
  ['Save threshold', 'Guardar umbral', 'Salvar limiar', '保存阈值'], ['All languages', 'Todos los idiomas', 'Todos os idiomas', '所有语言'],
  ['Find a lemma or character', 'Buscar lema o carácter', 'Pesquisar lema ou caractere', '查找词元或汉字'],
  ['Total words read', 'Total de palabras leídas', 'Total de palavras lidas', '已读总词数'], ['Total reading time', 'Tiempo total de lectura', 'Tempo total de leitura', '总阅读时间'],
  ['Mandarin characters read', 'Caracteres chinos leídos', 'Caracteres chineses lidos', '已读汉字数'],
  ['Bookmark saved offline; sync pending.', 'Marcador guardado sin conexión; pendiente de sincronización.', 'Marcador salvo offline; sincronização pendente.', '书签已离线保存，等待同步。'],
  ['Your library', 'Tu biblioteca', 'Sua biblioteca', '你的书库'],
  ['All books', 'Todos los libros', 'Todos os livros', '所有图书'],
  ['On shelf', 'En la biblioteca', 'Na estante', '书架上'],
  ['Set aside', 'Dejar para después', 'Deixar para depois', '暂时搁置'],
  ['Return to shelf', 'Volver a la biblioteca', 'Voltar à estante', '放回书架'],
  ['Currently reading', 'Leyendo', 'Lendo', '正在阅读'],
  ['Read', 'Leído', 'Lido', '已读'], ['Unread', 'Sin leer', 'Não lido', '未读'],
  ['Categories', 'Categorías', 'Categorias', '分类'], ['Uncategorized', 'Sin categoría', 'Sem categoria', '未分类'],
  ['New category', 'Nueva categoría', 'Nova categoria', '新建分类'], ['Edit category', 'Editar categoría', 'Editar categoria', '编辑分类'],
  ['Import book', 'Importar libro', 'Importar livro', '导入图书'], ['Book details', 'Detalles del libro', 'Detalhes do livro', '图书信息'],
  ['Book options', 'Opciones del libro', 'Opções do livro', '图书选项'], ['Title', 'Título', 'Título', '书名'], ['Author', 'Autor', 'Autor', '作者'],
  ['Language', 'Idioma', 'Idioma', '语言'], ['Book language', 'Idioma del libro', 'Idioma do livro', '图书语言'], ['Primary language', 'Idioma principal', 'Idioma principal', '主要语言'],
  ['Category', 'Categoría', 'Categoria', '分类'], ['Book cover', 'Portada', 'Capa', '封面'],
  ['Search…', 'Buscar…', 'Pesquisar…', '搜索…'], ['Search title or author', 'Buscar título o autor', 'Pesquisar título ou autor', '搜索书名或作者'],
  ['Any level', 'Cualquier nivel', 'Qualquer nível', '所有难度'], ['Recent', 'Recientes', 'Recentes', '最近添加'],
  ['Unfamiliar ↓', 'No vistos ↓', 'Não vistos ↓', '未见词 ↓'], ['Below threshold ↓', 'Bajo el umbral ↓', 'Abaixo do limiar ↓', '低于阈值 ↓'],
  ['Reading status', 'Estado de lectura', 'Estado de leitura', '阅读状态'], ['Sort books', 'Ordenar libros', 'Ordenar livros', '图书排序'],
  ['Estimated reading demand', 'Dificultad estimada', 'Dificuldade estimada', '预估阅读难度'],
  ['Novice', 'Inicial', 'Iniciante', '初级'], ['Intermediate', 'Intermedio', 'Intermediário', '中级'], ['Advanced', 'Avanzado', 'Avançado', '高级'],
  ['Superior', 'Superior', 'Superior', '优秀级'], ['Distinguished', 'Distinguido', 'Distinto', '卓越级'],
  ['Reading history', 'Historial de lectura', 'Histórico de leitura', '阅读记录'],
  ['Show reading details', 'Mostrar datos de lectura', 'Mostrar dados de leitura', '显示阅读详情'], ['Hide reading details', 'Ocultar datos de lectura', 'Ocultar dados de leitura', '隐藏阅读详情'],
  ['Settings', 'Ajustes', 'Configurações', '设置'], ['Save settings', 'Guardar ajustes', 'Salvar configurações', '保存设置'], ['Settings saved', 'Ajustes guardados', 'Configurações salvas', '设置已保存'],
  ['Cancel', 'Cancelar', 'Cancelar', '取消'], ['Close', 'Cerrar', 'Fechar', '关闭'], ['Save', 'Guardar', 'Salvar', '保存'], ['Remove', 'Eliminar', 'Remover', '删除'],
  ['Refresh', 'Actualizar', 'Atualizar', '刷新'], ['Try again', 'Intentar de nuevo', 'Tentar novamente', '重试'],
  ['Appearance', 'Apariencia', 'Aparência', '外观'], ['Language help', 'Ayuda lingüística', 'Ajuda linguística', '语言帮助'], ['Hotkeys', 'Atajos', 'Atalhos', '快捷键'],
  ['Narration', 'Narración', 'Narração', '朗读'], ['Book sources', 'Fuentes de libros', 'Fontes de livros', '图书来源'], ['Devices', 'Dispositivos', 'Dispositivos', '设备'],
  ['AI connection', 'Conexión de IA', 'Conexão de IA', 'AI 连接'],
  ['Interface language', 'Idioma de la interfaz', 'Idioma da interface', '界面语言'], ['Native language (L1)', 'Lengua materna (L1)', 'Língua materna (L1)', '母语 (L1)'],
  ['My reading languages', 'Mis idiomas de lectura', 'Meus idiomas de leitura', '我的阅读语言'], ['Add language', 'Añadir idioma', 'Adicionar idioma', '添加语言'],
  ['Optional', 'Opcional', 'Opcional', '可选'], ['Optional · e.g. English', 'Opcional · p. ej., español', 'Opcional · ex.: português', '可选，例如中文'],
  ['Translation language', 'Idioma de traducción', 'Idioma da tradução', '翻译语言'], ['Summary language', 'Idioma del resumen', 'Idioma do resumo', '摘要语言'],
  ['Hover behavior', 'Ayuda al pasar el cursor', 'Ajuda ao passar o cursor', '悬停帮助'], ['English translation', 'Traducción al inglés', 'Tradução para inglês', '英语翻译'],
  ['Translation', 'Traducción', 'Tradução', '翻译'], ['Definition', 'Definición', 'Definição', '释义'], ['Dictionary synonyms', 'Sinónimos de diccionario', 'Sinônimos de dicionário', '词典同义词'],
  ['Off', 'Desactivado', 'Desativado', '关闭'], ['Show pinyin above Mandarin characters', 'Mostrar pinyin sobre los caracteres chinos', 'Mostrar pinyin acima dos caracteres chineses', '在汉字上方显示拼音'],
  ['Theme', 'Tema', 'Tema', '主题'], ['Paper', 'Papel', 'Papel', '纸张'], ['Sepia', 'Sepia', 'Sépia', '棕褐色'], ['Dark', 'Oscuro', 'Escuro', '深色'], ['Dusk', 'Anochecer', 'Crepúsculo', '暮色'], ['Midnight', 'Medianoche', 'Meia-noite', '午夜'],
  ['Reader background', 'Fondo de lectura', 'Fundo de leitura', '阅读背景'], ['Paper texture', 'Textura de papel', 'Textura de papel', '纸张纹理'], ['Plain', 'Liso', 'Liso', '纯色'], ['Linen', 'Lino', 'Linho', '亚麻'], ['Graph paper', 'Cuadrícula', 'Quadriculado', '方格纸'],
  ['Font', 'Fuente', 'Fonte', '字体'], ['Font size', 'Tamaño de letra', 'Tamanho da fonte', '字号'], ['Line spacing', 'Interlineado', 'Espaçamento', '行距'],
  ['Page width', 'Ancho de página', 'Largura da página', '页面宽度'], ['Narrow', 'Estrecho', 'Estreito', '窄'], ['Balanced', 'Medio', 'Médio', '适中'], ['Wide', 'Ancho', 'Largo', '宽'],
  ['EPUB typography', 'Tipografía EPUB', 'Tipografia EPUB', 'EPUB 排版'], ['Auto-hide docks in full screen', 'Ocultar barras en pantalla completa', 'Ocultar barras em tela cheia', '全屏时自动隐藏工具栏'],
  ['Immersion mode', 'Modo inmersivo', 'Modo de imersão', '沉浸模式'], ['Quiet library', 'Biblioteca sencilla', 'Biblioteca simples', '简洁书库'],
  ['Hide page numbers, progress bars and audio clocks. Word help and reading controls stay available.', 'Oculta números de página, barras de progreso y relojes de audio. La ayuda y los controles siguen disponibles.', 'Oculta números de página, barras de progresso e relógios de áudio. A ajuda e os controles continuam disponíveis.', '隐藏页码、进度条和音频计时。词语帮助和阅读控件仍然可用。'],
  ['Keep book details collapsed and statistics in Reading history.', 'Mantiene los detalles de los libros cerrados y las estadísticas en el historial de lectura.', 'Mantém os detalhes dos livros recolhidos e as estatísticas no histórico de leitura.', '折叠图书详情，将统计数据放在阅读记录中。'],
  ['Reader preferences saved to your account.', 'Preferencias de lectura guardadas en tu cuenta.', 'Preferências de leitura salvas na sua conta.', '阅读偏好已保存到你的账户。'],
  ['Saving reader preferences…', 'Guardando preferencias…', 'Salvando preferências…', '正在保存阅读偏好…'],
  ['Preferences saved on this browser; account sync will retry.', 'Preferencias guardadas en este navegador; se volverá a intentar la sincronización.', 'Preferências salvas neste navegador; a sincronização será tentada novamente.', '偏好已保存在此浏览器，稍后将重试账户同步。'],
  ['Contents', 'Índice', 'Sumário', '目录'], ['Bookmarks', 'Marcadores', 'Marcadores', '书签'], ['Full screen', 'Pantalla completa', 'Tela cheia', '全屏'],
  ['Previous page', 'Página anterior', 'Página anterior', '上一页'], ['Next page', 'Página siguiente', 'Próxima página', '下一页'],
  ['Page summary', 'Resumen de página', 'Resumo da página', '本页摘要'], ['Summary', 'Resumen', 'Resumo', '摘要'], ['Summarize page', 'Resumir página', 'Resumir página', '生成本页摘要'],
  ['Go deeper', 'Profundizar', 'Aprofundar', '深入解读'], ['Ask the chatbot', 'Pregunta al chatbot', 'Pergunte ao chatbot', '向聊天机器人提问'], ['Ask question', 'Preguntar', 'Perguntar', '提问'],
  ['Question context', 'Contexto de la pregunta', 'Contexto da pergunta', '提问范围'], ['Current page', 'Página actual', 'Página atual', '当前页'], ['Book so far', 'Lo leído hasta ahora', 'O que já foi lido', '已读内容'],
  ['Ask about this page or what you’ve read so far…', 'Pregunta sobre esta página o lo que has leído…', 'Pergunte sobre esta página ou o que já leu…', '询问本页或目前已读的内容…'],
  ['Answers use your summary language and the text you’ve reached.', 'Las respuestas usan el idioma de los resúmenes y el texto que has leído.', 'As respostas usam o idioma dos resumos e o texto que você já leu.', '回答使用摘要语言，并基于你已经读到的文本。'],
  ['Search book and character guide', 'Buscar en el libro y consultar personajes', 'Pesquisar no livro e consultar personagens', '全书搜索与人物指南'],
  ['Explore this book', 'Explorar este libro', 'Explorar este livro', '探索本书'], ['Find a word or phrase', 'Buscar una palabra o frase', 'Pesquisar uma palavra ou frase', '查找词语或短语'],
  ['Search whole book', 'Buscar en todo el libro', 'Pesquisar no livro inteiro', '搜索全书'], ['Character guide', 'Guía de personajes', 'Guia de personagens', '人物指南'],
  ['Person to explain (optional)', 'Personaje que quieres entender (opcional)', 'Personagem para explicar (opcional)', '想了解的人物（可选）'],
  ['Explain characters and relationships', 'Explicar personajes y relaciones', 'Explicar personagens e relações', '解读人物与关系'],
  ['Save offline', 'Guardar sin conexión', 'Salvar para uso offline', '保存以供离线阅读'], ['Offline reading pack', 'Paquete de lectura sin conexión', 'Pacote de leitura offline', '离线阅读包'],
  ['Include audio', 'Incluir audio', 'Incluir áudio', '包含音频'], ['Recording', 'Grabación', 'Gravação', '录音'], ['Download reading pack', 'Descargar paquete de lectura', 'Baixar pacote de leitura', '下载阅读包'],
  ['Remove this book’s offline downloads', 'Eliminar las descargas sin conexión de este libro', 'Remover os downloads offline deste livro', '删除本书的离线下载'],
  ['Available offline on this device.', 'Disponible sin conexión en este dispositivo.', 'Disponível offline neste dispositivo.', '此设备上可离线阅读。'],
  ['Play', 'Reproducir', 'Reproduzir', '播放'], ['Pause', 'Pausar', 'Pausar', '暂停'], ['Speed', 'Velocidad', 'Velocidade', '速度'],
  ['Resume', 'Continuar', 'Continuar', '继续阅读'],
  ['Podcast mode', 'Modo pódcast', 'Modo podcast', '播客模式'], ['Compact player', 'Reproductor compacto', 'Reprodutor compacto', '紧凑播放器'], ['Now listening', 'Escuchando', 'Ouvindo', '正在收听'],
  ['Generate book audio', 'Generar audio del libro', 'Gerar áudio do livro', '生成全书音频'], ['Retry book audio', 'Reintentar audio del libro', 'Tentar gerar áudio novamente', '重试生成音频'],
  ['Generated narration', 'Narración generada', 'Narração gerada', '生成的朗读'], ['Analysis & audio', 'Análisis y audio', 'Análise e áudio', '分析与音频'],
  ['Mark as read', 'Marcar como leído', 'Marcar como lido', '标记为已读'], ['Mark as unread', 'Marcar como sin leer', 'Marcar como não lido', '标记为未读'],
  ['Vocabulary', 'Vocabulario', 'Vocabulário', '词汇'], ['Likely known', 'Probablemente conocido', 'Provavelmente conhecido', '可能已掌握'],
  ['Not yet seen', 'Aún no visto', 'Ainda não visto', '尚未见过'], ['L1 vocabulary excluded', 'Vocabulario de L1 excluido', 'Vocabulário da L1 excluído', '已排除母语词汇'],
  ['Unit', 'Unidad', 'Unidade', '单位'], ['Unique', 'Únicos', 'Únicos', '不重复数量'], ['Text total', 'Total del texto', 'Total do texto', '文本总量'], ['Seen', 'Vistos', 'Vistos', '已见过'],
  ['Discover books', 'Descubrir libros', 'Descobrir livros', '发现图书'], ['Find recommendations', 'Buscar recomendaciones', 'Buscar recomendações', '获取推荐'],
  ['What would you like to read?', '¿Qué te gustaría leer?', 'O que você gostaria de ler?', '你想读什么？'], ['Search Anna’s Archive', 'Buscar en Anna’s Archive', 'Pesquisar no Anna’s Archive', '在 Anna’s Archive 搜索'],
  ['Book downloads', 'Descargas de libros', 'Downloads de livros', '图书下载'], ['Queue if unavailable', 'Poner en cola si no está disponible', 'Colocar na fila se indisponível', '不可用时加入队列'],
  ['Download multiple books', 'Descargar varios libros', 'Baixar vários livros', '批量下载图书'], ['Download method', 'Método de descarga', 'Método de download', '下载方式'],
  ['Free slow download', 'Descarga lenta gratuita', 'Download lento gratuito', '免费慢速下载'], ['Fast download only', 'Solo descarga rápida', 'Somente download rápido', '仅快速下载'],
  ['Continue slow download', 'Continuar descarga lenta', 'Continuar download lento', '继续慢速下载'], ['Book download queued', 'Descarga del libro en cola', 'Download do livro na fila', '图书下载已加入队列'],
  ['Book imported', 'Libro importado', 'Livro importado', '图书已导入'], ['Book updated', 'Libro actualizado', 'Livro atualizado', '图书已更新'],
  ['Scan PDF with OCR', 'Escanear PDF con OCR', 'Digitalizar PDF com OCR', '使用 OCR 扫描 PDF'], ['OCR mode', 'Modo OCR', 'Modo OCR', 'OCR 模式'],
  ['Languages in this PDF', 'Idiomas de este PDF', 'Idiomas deste PDF', '此 PDF 中的语言'], ['Replace existing OCR', 'Reemplazar OCR existente', 'Substituir OCR existente', '替换现有 OCR'],
  ['Only scan pages without text', 'Escanear solo páginas sin texto', 'Digitalizar apenas páginas sem texto', '仅扫描无文本页面'], ['Create searchable copy', 'Crear copia con texto seleccionable', 'Criar cópia pesquisável', '创建可搜索副本'],
  ['Correct page rotation and skew', 'Corregir giro e inclinación', 'Corrigir rotação e inclinação', '校正页面旋转和倾斜'],
  ['Server URL', 'URL del servidor', 'URL do servidor', '服务器 URL'], ['API key', 'Clave API', 'Chave de API', 'API 密钥'], ['Remove saved API key', 'Eliminar clave API guardada', 'Remover chave de API salva', '删除已保存的 API 密钥'],
  ['Save and connect Audiobookshelf', 'Guardar y conectar Audiobookshelf', 'Salvar e conectar Audiobookshelf', '保存并连接 Audiobookshelf'],
  ['Export library', 'Biblioteca de destino', 'Biblioteca de destino', '导出目标书库'], ['Export folder', 'Carpeta de destino', 'Pasta de destino', '导出目标文件夹'],
  ['Export audio, book and cover to ABS', 'Exportar audio, libro y portada a ABS', 'Exportar áudio, livro e capa para ABS', '将音频、图书和封面导出到 ABS'],
  ['Import audio and sync with this book', 'Importar audio y sincronizar con este libro', 'Importar áudio e sincronizar com este livro', '导入音频并与本书对齐'],
  ['Link recording for progress sync', 'Vincular grabación para sincronizar progreso', 'Vincular gravação para sincronizar progresso', '关联录音以同步进度'],
  ['These are the same recording in both apps', 'Es la misma grabación en ambas aplicaciones', 'É a mesma gravação nos dois aplicativos', '两个应用中是同一份录音'],
  ['Resume ABS position', 'Continuar desde la posición de ABS', 'Continuar da posição do ABS', '从 ABS 位置继续'], ['Keep this position', 'Mantener esta posición', 'Manter esta posição', '保留当前位置'],
  ['No matching books', 'No hay libros coincidentes', 'Nenhum livro correspondente', '没有匹配的图书'], ['No books here yet', 'Todavía no hay libros', 'Ainda não há livros', '这里还没有图书'],
  ['Try a different search or filter.', 'Prueba otra búsqueda o filtro.', 'Tente outra pesquisa ou filtro.', '请尝试其他搜索词或筛选条件。'],
  ['Choose a book to read.', 'Elige un libro para leer.', 'Escolha um livro para ler.', '选择一本想读的书。'],
];
const messages = Object.fromEntries(phrases.map(([en, es, pt, zh]) => [en, { en, es, pt, zh }]));
let language = 'en', observer;
const sources = new WeakMap(), attributeSources = new WeakMap();
const excluded = '#viewer,#word-help,.book-title,.book-meta,.book-cover,#reading-title,#reading-subtitle,#podcast-book-title,#narration-chapter,#summary-body,#summary-detail-body,#summary-detail-title,#summary-question-answer,#character-guide-output,#book-search-results,#learning-title,#offline-book-title,#book-metadata-status,.discovery-card > h2,.discovery-card > p,[data-user-content],datalist,script,style,textarea';
export const interfaceLanguage = () => language;
export function translateUI(value, locale = language) {
  if (messages[value]) return messages[value][locale] || value;
  const parts = value.split(' · '), translated = parts.map((part) => {
    const match = /^([^:]+): (.+)$/u.exec(part); return match && messages[match[1]] ? `${messages[match[1]][locale] || match[1]}: ${match[2]}` : part;
  });
  return translated.join(' · ');
}
function ignore(node) { return node.parentElement?.closest(excluded); }
function text(node) {
  if (ignore(node) || !node.data?.trim()) return;
  let state = sources.get(node);
  if (!state || node.data !== state.rendered) state = { source: node.data };
  const trimmed = state.source.trim(), next = state.source.replace(trimmed, translateUI(trimmed));
  state.rendered = next; sources.set(node, state); if (node.data !== next) node.data = next;
}
function attributes(element) {
  if (!element.matches || element.closest(excluded)) return;
  if (element.tagName === 'OPTION' && !element.hasAttribute('value')) element.value = element.textContent;
  const saved = attributeSources.get(element) || {};
  for (const name of ['title', 'aria-label', 'placeholder']) {
    const value = element.getAttribute(name); if (!value) continue;
    let state = saved[name]; if (!state || value !== state.rendered) state = { source: value };
    state.rendered = translateUI(state.source); saved[name] = state; if (value !== state.rendered) element.setAttribute(name, state.rendered);
  }
  attributeSources.set(element, saved);
}
function scan(root) {
  if (root.nodeType === 3) return text(root);
  if (root.nodeType !== 1 && root.nodeType !== 9) return;
  attributes(root);
  for (const element of root.querySelectorAll('*')) attributes(element);
  const walker = document.createTreeWalker(root, 4); while (walker.nextNode()) text(walker.currentNode);
}
export function setInterfaceLanguage(value) {
  language = ['en', 'es', 'pt', 'zh'].includes(value) ? value : 'en';
  document.documentElement.lang = language; scan(document.body);
  const names = new Intl.DisplayNames(language, { type: 'language' });
  for (const option of document.querySelectorAll('#languages option')) { try { option.label = names.of(option.value); } catch {} }
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver((records) => { for (const record of records) {
      if (record.type === 'characterData') text(record.target);
      else if (record.type === 'attributes') attributes(record.target);
      else for (const added of record.addedNodes) scan(added);
    } });
    observer.observe(document.body, { subtree: true, characterData: true, childList: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder'] });
  }
}
