import json
import pathlib
import xml.etree.ElementTree as ET

root = pathlib.Path(__file__).resolve().parent
ns = '{http://www.w3.org/2000/svg}'
for directory in (root / 'web', root / 'projet'):
    report = json.loads((directory / 'report.json').read_text(encoding='utf-8'))
    for item in report['items']:
        svg = ET.parse(directory / (item['name'] + '.svg')).getroot()
        groups = [el for el in svg.iter() if el.tag == ns + 'g']
        ids = [el.get('id') for el in groups if el.get('id')]
        print(directory.name, item['name'], 'method=' + item['traceMethod'],
              'paths=' + str(item['metrics']['paths']), 'groups=' + str(len(groups)), 'named=' + str(ids))
