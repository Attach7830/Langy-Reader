import os
from faster_whisper.utils import download_model

download_model('base', output_dir=os.path.join(os.environ.get('LANGY_MODELS', './models'), 'whisper'))
