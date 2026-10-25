Refactorizar los dos componentes. De Visual Codec. Agentescontrol_opencode y voz
Estos dos recursos son nuestros y están actualmente desistalados. 
La idea es refactorizar los dos en uno solo. En este nuevo proyecto OpenCode_Alfred. 

Habrá tres paneles que ocuparán la misma posición que ocupan ahora. 
Panel de voz A la derecha como ahora y secundary side bar
panel dictado por voz en Panel coomo ahora
explorador de agentes/skills/mcps de Primary side bar como ahora

voz y dictado comparten estilo visual, y hay que rediñear el panel de control de agentes para que tenga el mismo estilo. es el que hay que cambiar el estimo mas.

Guia para refactorizar el [Explorador de agentes] el sida bar principal (a la izquierda)

dos botones en una linea para editar los dos agents.md pero para dicferenciarloa en los botones poners [ Global] [ Local] con un icono de un cerebro para cada una.
y aqui un boton pequeño pero comodo para abrir la ultima sesion de opnecode. si no hay pues sesion nueva
Luego los agentes 
de proyecyos .
globales (en lugar de usuario)
integrados.
(todos con un icono adaptado al nuevo diseño, y con indicador claro cuando esten trabajando)
los mcp apartem, en dos columnas con controles para activar y desactivar.
los skills aparte, dos listas para los globales y locales, pero inicialmente colpsado
los plugings aparte como los mcp en dos columnas con controles para activar y desactivar.

mejoramos la ventana de contexto para adaptarla al nuevo estilo mas futurista
- un cuadro arra de x*y que se va llenando de color, con leyenda abajo de cada color (en dos columnas las leyendas )

Y cambiar la funcuionalidad de mostrar a los agentes trabajando. 
cuando esten trabahando aedmas de activarse en la lista de agente. tambien se veran en el ecualizador de vos , que ya no sera solo para la voz.
El ecualizador de voz funcionara como ahora. pero ademas, mostrara tambien ecualizacion visual cuando los agentes y sub agentes esten trabajando
cuando un agente este trabajando, debajo de la esfera para el sinido, aparece una tarjeta con el nombre del agente a la izquierda y un display a la derecha como un panel de pixeles con un scroll simulando una estela de proceso.
y si hay mas de una, apareceian como una lista de agentes cada uno con su efecto al lado.


-----------------------------

Fase 3. Compatible con Claud y Codex
por defecto opencode [.Open.]
cambiar el boton de Sesion . ahora tendra selector izquierda derecha, y en el boton pondra el agente de codigo.
<[.Open.]><[.Claude.]><[.Codex.]>

al abrir la sesion con claude, panel con terminal con claude, si esta la opencode o codex no la quitamos, 
igual con codex y con opencode, respetamos que pueda haber una terminal con cada agente en los paneles centrales. pero no repetir las que ya existan.



-------------------------

Fase de refactorizacion del panelquierdo, Ahoramismo tenemos
>[Explorador]
>[Modelos]
>[Contexto]

Nuevo
>[Mando]
[Global][Proyecto] [<][Icono de la aplicacion][<>]
[ X ] Aceptar todo sin preguntar.

>[Explorador] (Lista de agentes)
[Agentes de Proyecto].............(colapsable)
[Icono] [Nombre.....][modelo][Ejecto_Trabajo] [TokesTotales/TokesenSesion] [Ver][Edit] (Ver = sacar la pestaña. Edit = Editar .md)
[Agentes Globales   ].............(colapsable)(globales e internos)
[Icono] [Nombre.....][modelos][Ejecto_Trabajo] [TokesTotales/TokesenSesion] [Ver][Edit] (Ver = sacar la pestaña. Edit = Editar .md)
* Cada agente con forma de tarjeta borde suave no muy alta. (suelen ser muchos)
>[Control]
[MCP Globales]   [MCP Proyecto]
[ X ] Nombre   | [ X ]  Nombre
-
[Plugins Globales]   [Plugins Proyecto]
[ X ] Nombre   | [ X ]  Nombre
-
[Skill Globales] (Colapsable)
[ Swhit delante ] : Nombre de la skill (color diferencial si esta activa o no)

[Skill Proyecto] (Colapsable)
[ Swhit delante ] : Nombre de la skill (color diferencial si esta activa o no)

>[Modelos] (sin cambios)
>[Contexto] (sin cambios)

* Aprobechar el espacio vertical. no se trata de hacerlo mas ficno, o usar letra pequeña. se trata de poner varias lineas en una sola. eveitar lineas de label innecesarias.
-------------------------
# Questions
En la tarjeta de agente: [Icono][Nombre][modelo][Ejecto_Trabajo][Tokens…][Ver][Edit] — ¿qué debe mostrar «Ejecto_Trabajo»?
(Efecto_Trabajo) Estado de trabajo en streaming, una animacion mientras trabaja
El botón [Ver] («sacar la pestaña») ¿qué abre?
La pestaña del editor de agentes del panel central. (las mismas que abren ahora, asegurate que entiendes esto bien)
La [X] delante de cada MCP y Plugin: ¿qué hace?
Desactivar (switch)
Las tarjetas con [TokensTotales/TokensSesión]: los datos de tokens por agente hoy solo existen para opencode (SQLite). ¿Qué hago con las filas de Claude/Codex?
Contar también en Claude/Codex


--------------- 
# panel izquierdo, contenedor de Modelos
> Los dos botones como ahora
> ACTUAL : [Nombre del modelo] [*][B] 
(todo en una sola linea. no hay nada mas debajo si no se oulsa algun desplegable.) 
[*] Justificado a la derecha un icno desplegable, para desplegar los 5 recientes, (sin titulo, solo los 5 modelos.
[B] Lupa de Buscar, Abre el despleble de busqueda, Linea para la caja de texto del filtro, y debajo lista de modelos filtrados.
# Block de notas 
> Al enciar el pronmt no envia bien los saltos de linea, lo envia todo como una linea

# Ecualizador de voz - Agentes
> Cada anete tiene un color definido en su pane de agentes, que el ecualizador de los ajentes (pixeles voladores) se ajuste a ese color.