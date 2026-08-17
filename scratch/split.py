import os

content = open(r'C:\Users\pc\Desktop\ANIMATION.txt', 'r', encoding='utf-8').read()

html_top = content.split('<style>')[0]
css = content.split('<style>')[1].split('</style>')[0]
html_mid = content.split('</style>')[1].split('<script>')[0]
js = content.split('<script>')[1].split('</script>')[0]

os.makedirs('scratch/animation', exist_ok=True)

open('scratch/animation/index.html', 'w', encoding='utf-8').write(html_top + '<link rel="stylesheet" href="style.css">\n' + html_mid + '\n<script src="script.js"></script>\n</html>')
open('scratch/animation/style.css', 'w', encoding='utf-8').write(css)
open('scratch/animation/script.js', 'w', encoding='utf-8').write(js)
