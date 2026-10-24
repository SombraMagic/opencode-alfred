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






