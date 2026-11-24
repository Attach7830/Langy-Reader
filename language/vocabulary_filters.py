"""Source-aware lexical filters, independent of the NLP tokenizer/model."""
import unicodedata

HYPHENS = {'-', '\u2010', '\u2011'}


def lexical_tokens(text, tokens):
    positions, offset = {0: 0}, 0
    for index, char in enumerate(text):
        offset += 2 if ord(char) > 0xffff else 1
        positions[offset] = index + 1

    def connected(char):
        return char.isalnum() or unicodedata.category(char).startswith('M') or char in HYPHENS | {'_', '.', '/'}

    def has_numeral(token):
        start, end = positions[token['from']], positions[token['to']]
        while start > 0 and connected(text[start - 1]): start -= 1
        while end < len(text) and connected(text[end]): end += 1
        return any(char.isnumeric() for char in text[start:end]) or any(char.isnumeric() for char in token['lemma'])

    result, index = [], 0
    while index < len(tokens):
        token = dict(tokens[index]); index += 1
        if token['word'].casefold() == 'anti' and index < len(tokens):
            following = tokens[index]
            gap = text[positions[token['to']]:positions[following['from']]]
            if gap in {'', *HYPHENS} and following['word'][0].isalpha():
                start = token['from']
                token = {**following, 'word': text[positions[start]:positions[following['to']]], 'from': start,
                         'lemma': 'anti' + following['lemma'].replace(' ', ''), 'lemmaSource': 'bound anti-prefix'}
                if following.get('components'):
                    components = [dict(part) for part in following['components']]
                    components[0] = {**components[0], 'lemma': 'anti' + components[0]['lemma'], 'from': start}
                    token['components'] = components
                index += 1
        if has_numeral(token): continue
        # Some lookup models represent one attached prefix as a spaced lemma.
        if token['word'].casefold().startswith('anti') and token['lemma'].startswith('anti '):
            token['lemma'] = token['lemma'].replace(' ', '')
        result.append(token)
    return result


def lemma_inventory(tokens, language):
    lemmas = set()
    for token in tokens:
        if token.get('properName'): continue
        lemma, word = token['lemma'], token['word'].casefold()
        if language == 'es' and word in {'al', 'del'}:
            lemmas.update(('a' if word == 'al' else 'de', 'el'))
        elif language == 'pt' and token.get('pos') == 'ADP' and ' ' in lemma:
            lemmas.update(lemma.split())
        elif token.get('components'):
            lemmas.update(part['lemma'] for part in token['components'])
        else: lemmas.add(lemma)
    return sorted(lemmas)
