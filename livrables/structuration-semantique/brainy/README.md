# Brainy — calques sémantiques à examiner

Le fichier `brainy-groupes.svg` reprend le prototype vectoriel articulé précédemment créé pour Brainy. Il ne s'agit pas d'une nouvelle détection automatique : les douze groupes existants sont conservés et exposés comme calques Inkscape. Les originaux sont inchangés.

Le nom gauche/droite correspond au côté vu à l'écran. Les groupes séparés sont :

- `corps-et-joues` : corps, visage blanc et joues, ensemble ;
- `oeil-gauche`, `oeil-droit` et `bouche` ;
- `pince-gauche`, `pince-droite` ;
- trois pattes par côté : `patte-*-haute`, `patte-*-milieu`, `patte-*-basse`.

Dans Inkscape, ouvrir le panneau **Calques et objets** pour sélectionner ou masquer les parties. `brainy-calques-apercu.png` montre chaque groupe isolé dans son emplacement. Pour tester la visibilité individuellement, servir ce dossier sur un serveur local et ouvrir `apercu.html` ; l'aperçu ne modifie pas le SVG.

Vérification : les douze groupes ont été isolés et rendus ; le rendu RGBA complet à 840 × 548 pixels est identique octet pour octet à celui du prototype source (Sharp/librsvg). Ce contrôle compare les deux SVG, pas la fidélité à l'image matricielle d'origine. Les tracés et les masques sont issus d'une conversion automatique et forment un fichier lourd (environ 4,3 Mo). Le corps et les joues restent un seul groupe, les pinces ne sont pas elles-mêmes articulées, et certaines zones masquées ne sont pas reconstruites sous les autres éléments : bouger un membre peut donc révéler des coupures ou des manques. Aucun rig d'animation ni contrôle en application n'est livré ici.
