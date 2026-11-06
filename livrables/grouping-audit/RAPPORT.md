# Évaluation du regroupement — 18 images

## Protocole

Le 6 novembre 2026, RastaVec CLI a vectorisé 10 PNG du corpus web et 8 images de contrôle du projet ou de Brainclaw, avec les réglages par défaut : Auto, seuil d’écart 3 %, budget 400 Kio et comparatifs activés. Les sources web, leurs auteurs et licences sont documentés dans `../../tests/fixtures/grouping-corpus/README.md` et `../../tests/fixtures/pixel-art/README.md`. Les images internes ont été lues sans modifier les originaux. Les rapports JSON ci-dessous conservent les chemins exacts des sources et les paramètres retenus.

Les comparaisons montrent la source à gauche et le SVG à droite, sur blanc en haut et sur fond sombre en bas. L’écart est le pourcentage de pixels dont la différence maximale sur au moins un canal dépasse 32/255 sur l’un de ces deux fonds ; il ne mesure pas à lui seul la qualité visuelle ou la sémantique. La colonne « chemins » comprend aussi, le cas échéant, les chemins techniques des masques.

## Résultats

| Image | Dimensions | Méthode retenue | Écart | Chemins | Poids (octets) | État | Comparaison |
|---|---:|---|---:|---:|---:|---|---|
| armor | 21 × 19 | vtracer ×4 | 0 % | 176 | 10208 | ok | [voir](web/armor.comparison.png) · [SVG](web/armor.svg) |
| bat | 256 × 256 | vtracer | 2.71 % | 68 | 32067 | ok | [voir](web/bat.comparison.png) · [SVG](web/bat.svg) |
| gold | 17 × 19 | vtracer ×4 | 0 % | 140 | 8362 | ok | [voir](web/gold.comparison.png) · [SVG](web/gold.svg) |
| hamster-sheet | 688 × 86 | vtracer | 18.9714 % | 271 | 79108 | review | [voir](web/hamster-sheet.comparison.png) · [SVG](web/hamster-sheet.svg) |
| kenney-arrow | 34 × 22 | pixel-grid | 0 % | 74 | 4664 | ok | [voir](web/kenney-arrow.comparison.png) · [SVG](web/kenney-arrow.svg) |
| kenney-bear | 154 × 132 | vtracer ×4 | 0.7379 % | 1064 | 65150 | ok | [voir](web/kenney-bear.comparison.png) · [SVG](web/kenney-bear.svg) |
| kenney-button | 64 × 64 | pixel-grid | 0 % | 981 | 45456 | ok | [voir](web/kenney-button.comparison.png) · [SVG](web/kenney-button.svg) |
| kenney-dog | 129 × 157 | vtracer ×4 | 0.5431 % | 1214 | 72579 | ok | [voir](web/kenney-dog.comparison.png) · [SVG](web/kenney-dog.svg) |
| kenney-frog | 130 × 144 | vtracer ×4 | 1.3942 % | 775 | 46162 | ok | [voir](web/kenney-frog.comparison.png) · [SVG](web/kenney-frog.svg) |
| spell | 121 × 120 | vtracer ×2 | 2.7617 % | 1779 | 170284 | ok | [voir](web/spell.comparison.png) · [SVG](web/spell.svg) |
| 32x32 | 32 × 32 | vtracer ×4 | 3.2227 % | 486 | 27104 | review | [voir](projet/32x32.comparison.png) · [SVG](projet/32x32.svg) |
| brainy-120 | 128 × 128 | vtracer ×4 | 2.1301 % | 4817 | 281839 | ok | [voir](projet/brainy-120.comparison.png) · [SVG](projet/brainy-120.svg) |
| potion | 15 × 21 | pixel-grid | 0 % | 192 | 7990 | ok | [voir](projet/potion.comparison.png) · [SVG](projet/potion.svg) |
| rastavec-mascot-1 | 1254 × 1254 | vtracer | 3.8158 % | 839 | 367787 | review | [voir](projet/rastavec-mascot-1.comparison.png) · [SVG](projet/rastavec-mascot-1.svg) |
| rastavec-path | 1254 × 1254 | vtracer | 0.3297 % | 2 | 11259 | ok | [voir](projet/rastavec-path.comparison.png) · [SVG](projet/rastavec-path.svg) |
| shield | 17 × 21 | vtracer ×4 | 0 % | 164 | 9114 | ok | [voir](projet/shield.comparison.png) · [SVG](projet/shield.svg) |
| sword | 21 × 21 | pixel-grid | 0 % | 129 | 5430 | ok | [voir](projet/sword.comparison.png) · [SVG](projet/sword.svg) |
| tiny-wizard | 32 × 32 | vtracer ×4 | 0 % | 287 | 17059 | ok | [voir](projet/tiny-wizard.comparison.png) · [SVG](projet/tiny-wizard.svg) |

Les rapports complets sont disponibles pour le [corpus web](web/report.json) et les [images de contrôle](projet/report.json). Les sorties `review` dépassent le seuil ou le budget : ce n’est pas une erreur de traitement.

## Lecture des regroupements

Les 18 SVG ont été examinés comme XML. Aucune sortie automatique ne contient de groupes nommés correspondant à des objets tels que « œil », « pince », « corps » ou « lettre ». Les groupes `soft-1`, `soft-2` et ceux portant une opacité ou une découpe sont des mécanismes de rendu, pas une segmentation sémantique.

Le mode grille a été retenu sur `kenney-arrow`, `kenney-button`, `sword` et `potion` : leurs chemins sont des rectangles résultant de la fusion de pixels de même RGBA ; ils sont individuellement vectoriels mais n’isolent pas un objet entier. Pour `kenney-button`, 3 320 pixels visibles produisent encore 981 chemins. Une couleur ou opacité différente interrompt la fusion. Les autres sorties utilisent VTracer ; un fichier de faible écart peut rester complexe : `brainy-120` atteint 2,13 % avec 4 817 chemins.

Une inspection visuelle ponctuelle a été faite sur Brainy, l’icône 32 px, l’épée, la grenouille, le bouton, le sort et la planche de hamsters. Le sort conserve sa composition générale avec une simplification visible ; les hamsters perdent plusieurs nuances et détails, ce qui est cohérent avec leur écart de 18,97 %. La comparaison visuelle reste qualitative et limitée.

Le regroupement de pixels dépend de la méthode retenue, et le choix automatique dépend du score et du budget : une image visuellement pixellisée peut néanmoins être exportée par VTracer. Les `g` techniques ne doivent pas être présentés comme des éléments indépendants prêts à animer. Les prototypes Brainy/RastaVec structurés manuellement ou repris de préparations antérieures ne valident pas une détection automatique.

## Prototype de groupes géométriques — essai distinct

Le prototype ajouté dans l’éditeur ne détecte pas les objets. Il mesure la distance entre les contours approximés des chemins voisins, puis enveloppe des chemins consécutifs dans le même parent `<g>`, sans les réordonner. Cette comparaison évite de relier deux formes au seul motif que leurs grandes boîtes englobantes se chevauchent ; les sous-contours composés sont évalués ensemble pour respecter les trous. Les tests couvrent un contour concave et un chemin situé dans le trou d’un tracé composé. L’algorithme reconnaît uniquement une partie des chemins générés par RastaVec, et laisse intacts les SVG avec CSS embarqué ou les tracés d’une syntaxe non prise en charge. Les groupes restent des suggestions éditables, sans cohérence sémantique garantie.

La vérification locale a rendu avant/après à leur taille native avec Sharp et comparé chaque canal RGBA. Tous les cas ci-dessous ont zéro pixel différent ; cela vérifie la conservation du rendu de ces échantillons, pas la qualité sémantique des groupes. Le moteur propose un niveau fin de proximité et, lorsque plusieurs groupes voisins sont consécutifs dans l’ordre de dessin, un ensemble parent plus large.

| SVG d’essai | Taille | Groupes fins / parents | Chemins dans les groupes fins / examinés | Résultat |
|---|---:|---:|---:|---|
| Mascotte RastaVec (SVG auto) | 1254 × 1254 | 16 / 0 | 34 / 838 | rendu identique |
| Brainy-120 (SVG auto) | 128 × 128 | 896 / 152 | 2530 / 4776 | rendu identique, fragmentation élevée |
| Logo RastaVec | 2172 × 724 | 0 / 0 | 0 / 161 | rendu identique, aucun groupe suggéré |
| Grenouille Kenney | 130 × 144 | 90 / 0 | 193 / 772 | rendu identique |
| Chauve-souris | 256 × 256 | 3 / 0 | 6 / 67 | rendu identique |
| Bouton Kenney | 64 × 64 | 63 / 6 | 752 / 981 | rendu identique |
| Brainy structuré en couches | 420 × 274 | 0 | SVG non pris en charge | laissé intact |
| Synthétique avec recouvrements, opacité et clipPath | 200 × 200 | 2 | 5 / 5 | rendu identique |

Un essai de l’interface a aussi vectorisé la mascotte PNG de 1254 × 1254 en 87 s (846 chemins). Le panneau a proposé 23 groupes ; l’aperçu isolé a chargé à 1254 × 1254 et le téléchargement séparé `rastavec-mascot-1-groupes.svg` s’est déclenché. Après téléchargement, le SVG UI a été rendu et comparé au tracé : zéro différence de canal RGBA. [Télécharger le SVG groupé de l’essai UI](projet/rastavec-mascot-1-groupes-ui.svg). Cette sortie UI est un autre essai que le SVG du tableau, d’où un compte de groupes différent. Le ZIP du lot n’incorpore pas ce résultat.

Un essai UI actualisé sur Brainy-120 a proposé 1041 groupes au total, dont 152 ensembles larges. L’aperçu isolé a conservé 128 × 128 px. Ce SVG provient d’une vectorisation UI distincte de l’entrée du tableau, ce qui explique le total différent. Après avoir renommé un ensemble « Brainy contour test », l’export a contenu le titre et l’`aria-label` personnalisés. Comparé au SVG tracé de cet essai, il a zéro différence de canal RGBA. [Télécharger cet export hiérarchique](projet/brainy-120-groupes-hierarchiques-ui.svg).

Les noms automatiques utilisent la couleur dominante et la zone de l’image, par exemple « Groupe · 4 formes · bleu · en haut à gauche ». Ils n’essaient pas d’identifier des rôles. Ils peuvent être modifiés avant l’export ; le nom devient le `<title>` et l’`aria-label` du groupe SVG. Pour rendre la revue plus praticable sur les sorties denses, la gestion des groupes occupe maintenant toute la largeur sous l’aperçu : liste hiérarchique avec recherche et filtres à gauche, édition du nom et aperçu isolé à droite. Sur petit écran, ces deux panneaux s’empilent.

La limite qui ressort est la fragmentation : les groupes fins sont souvent des paires de chemins, et les 896 groupes fins de Brainy dans l’entrée CLI du tableau ne sont pas 896 objets identifiés. Les 152 ensembles parents du même essai donnent un niveau de navigation plus large, sans annotation sémantique. Le SVG UI distinct compte 1041 suggestions au total et 152 parents. Le logo complexe est un échec utile : malgré 161 chemins, aucun groupe ne respecte le voisinage nécessaire. La version actuelle reste une revue géométrique avec nommage descriptif ; elle n’établit pas encore une détection automatique de parties sémantiques.

## Limites

Échantillon restreint, un seul préréglage et un seul budget, rendu Node/Sharp plus une comparaison UI ciblée sur Brainy-120 ; pas de vérité terrain pour le nombre correct de parties sémantiques, et pas de test d’articulation ou d’animation. Les résultats ne démontrent pas qu’un groupe soit sélectionnable comme une partie complète dans l’application.
