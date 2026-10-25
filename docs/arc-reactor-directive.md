# ARC REACTOR · brief de reconstrucción

El reactor 3D se ha retirado del código. Este documento es el pliego de
condiciones para rehacerlo desde cero: qué es, cómo se comporta y qué
errores ya pagados no hay que repetir.

---

## 1. Qué es

Un reactor industrial, no un disco ni un objeto brillante. Capas
concéntricas alineadas sobre el eje Z, con un núcleo de plasma en el centro
y toda la energía **entrando** por el anillo exterior.

---

## 2. Anatomía (capas, de fuera hacia dentro)

| # | Pieza | Radio (marco = 1.0) | Notas |
| --- | --- | --- | --- |
| ① | Marco exterior | 1.00 | Chasis circular de acero cepillado oscuro, con desgaste, marcas de mecanizado y óxido leve. |
| ② | Bloques electromagnéticos de borde | 1.00 | **10** bloques macizos, repartidos a **36°**. Cada uno: cierre hidráulico encajado, puerto de conexión posterior y dos pernos de ajuste de alta presión. |
| ③ | Banda de remaches | 0.86 | 24 remaches sobre acero cepillado claro. |
| ④ | Corona dentada exterior | 0.68 | 40 dientes de corte recto + perforaciones circulares de aligeramiento. Gira. |
| ⑤ | Corona dentada interior | 0.45 | 24 dientes + aligeramientos. **Contrarrota** con la exterior. 6 micro-rodamientos las unen. |
| ⑥ | Anillo de ranuras | 0.68–0.86 | Placa con **36** ranuras radiales en abanico + **6** pernos hexagonales de retención a 60°. |
| ⑦ | Brazos radiales | 0.45–1.00 | 4 vigas gruesas en cruz con un ajustador hidráulico (pistón) cada una. |
| ⑧ | Chasis trasero | 0.66 | Masa trasera de la máquina. |
| ⑨ | Alojamiento taperizado | 0.30 → 0.36 | Pared cónica profunda, coaxial con Z, que se estrecha del fondo hacia la lente. Va apagada: es la sombra contra la que brilla la luz. |
| ⑩ | Rieles longitudinales | 0.68 | 12 guías cortas donde la luz entra. |
| ⑪ | Housing | 0.34 | Cilindro pulido. |
| ⑫ | Bisel de retención | 0.245 | Bisel metálico con muescas radiales micrométricas que envuelve la lente. |
| ⑬ | Lente emisiva | 0.19 | Plasma cian/azul (#00f0ff) con un **foco blanco en el centro exacto**. |
| ⑭ | Volumen de luz | 0.86 → 0 | Embudo de luz que entra por las 36 ranuras y converge en la gema. |

---

## 3. Reglas (las que ya fallaron y costaron tiempo)

### 3.1 Convergencia
- El **vértice** del haz (punto de fuga) va clavado en el centro de la gema.
  Exactamente `(X: 50 %, Y: 50 %)`, sin excusas.
- El **eje** del volumen es el eje Z de la escena. Ni un grado de
  inclinación en X ni en Y. Un volumen torcido se lee como un objeto suelto
  encajado encima de la interfaz.
- La boca ancha se alinea con el anillo exterior y el radio **decrece
  linealmente hasta cero**: perspectiva cónica, no parábola.
- Con la cámara de frente, el haz **no puede tapar la gema**: se disuelve
  antes de llegar al centro y el cristal se ve limpio.

### 3.2 Nada de cuerdas ⚠️
> **El fallo más caro: el reactor parecía un arpa.**

Cualquier línea delgada y larga que llegue al centro —un haz, una estela,
un riel, un brazo— se lee como **la cuerda de un arpa tendido sobre el
núcleo**, no como luz o como maquinaria. Con 36 de ellas, el conjunto deja
de ser una máquina.

Reglas:
- **Ninguna** línea brillante y fina puede recorrer el camino del centro.
- La convergencia la cuenta el **volumen**, no las líneas: un cono con
  degradado radial (brillo hacia fuera, disipación hacia la gema).
- Si hacen falta marcas radiales, son **cortas**:ievertones en la entrada,
  no cuerdas de largo completo.
- Las piezas metálicas que cruzan la luz son **vigas**: anchas y cortas. Una
  viga de 0.1 de ancho leyéndose como cuerda es un problema de proporción,
  no de cantidad.

### 3.3 Nada de conos sueltos
- Un cono metálico brillante alrededor del núcleo se lee como un **sombrero**
  encajado encima. La carcasa interior va oscura y sin 광고: es fondo, no
  protagonista.
- Ningún volumen luminoso puede flotar delante de la máquina como pieza
  independiente: si se ve, tiene que estar **atado** a ella (sale de una
  ranura, de un hueco, de un conducto).

### 3.4 La máquina tiene que ser máquina
- Contraste de material: metal legible (chispas, cantos, sombras) contra
  luz aditiva. Si todo es brillante, no hay forma.
- La energía no puede saturar el centro: si la gema se pierde en un disco
  blanco, se ha pasado de vueltas.

---

## 3 bis. Cómo se monta en el HUD (estado actual)

El reactor se compone de **caplas de imagen** apiladas en `.reactor-stack`,
cada una con su propio recorte PNG (fondo negro eliminado por alfa, medido
en el navegador sobre el render de 1280 px).

De fuera hacia dentro, en % del semiradio de la caja:

| Capa | Pieza | Radio | Movimiento |
| --- | --- | --- | --- |
| Anillo 1 | Acero exterior con 8 pestañas | cuerpo 50,3–76,6 · pestañas 76,6–85,5 | 0,2 RPM (300 s/vuelta) + muescas de 36° |
| Anillo 2 | Corona con LED + plasma | corona 38,5–50,3 · plasma 0–44,8 | corona horaria 12 s · plasma antihorario 5 s |
| Anillo 3 | 10 módulos de potencia + cobre | módulos 76,6–85,5 · cobre 15,7–36 | giro a saltos de 36° (steps(10)) |

**Reglas de encaje:**
- Todo es **concéntrico**: el centro de las tres capas es el mismo píxel.
- Los módulos del Anillo 3 caen al **mismo radio que las pestañas del
  Anillo 1**: las pestañas los agarran por fuera.
- La corona del Anillo 2 (38,5–50,3) y el marco del Anillo 1 (50,3–76,6)
  quedan **visibles en medio**, sin que ninguna capa se coma a la otra.
- El centro del Anillo 3 va **calado**: el plasma se ve por el hueco.

**El eje de cada anillo (lo que de verdad hay que alinear):**

El centro visual de una capa NO es el centro de su imagen: los renders son
vistas en perspectiva con iluminación lateral, así que el centroide del alfa
se desvía varios píxeles. El eje fiable se mide sobre las features
**repetidas y simétricas** (pestañas, LED, módulos), que no dependen de la
luz:

| Anillo | Rasgo medido | Eje en su imagen | Desvío en su caja | Corrección en la raíz |
| --- | --- | --- | --- | --- |
| 1 | 8 pestañas | (640, 640) de 1280 | 0,00 | ninguna |
| 2 | anillo de LED | (636,4, 658,2) de 1280 | −1,59 / +7,94 px | `translate(1.03px, −5.15px)` |
| 3 | 10 módulos | (322,8, 346,3) de 644 | +0,38 / +18,99 px | `translate(−0.38px, −18.99px)` |

Y el `transform-origin` de cada capa que gira va a **su eje**, no al centro
de la caja: si no, la pieza describe una órbita al girar en vez de girar
sobre sí misma.

---

## 4. Directiva para un agente / LLM

> **Principio de convergencia.** El vector del haz cónico tiene su base
> circular mayor alineada con el anillo exterior y su vértice (punto de
> fuga) fijado exactamente en las coordenadas centrales del núcleo
> (X: 50 %, Y: 50 %). Todos los haces radiales viajan desde el borde exterior
> disminuyendo su diámetro hasta colapsar en el centro brillante. Efecto de
> embudo de luz tridimensional visto en perspectiva frontal profunda.
>
> **Sin elementos sueltos.** Ningún volumen luminoso, casca o embudo puede
> leerse como un objeto independiente colocado encima de la interfaz: si el
> metal tiene que estar, va coaxial con el eje Z y su silueta no puede
> cruzar la del haz.
>
> **Sin cuerdas.** Ninguna línea delgada y larga puede ir del anillo al
> centro: se leería como un arpa.
>
> **Lenguaje.** No digas "cono": di *haz de luz*, *estela en forma de embudo
> volumétrico*, *convergencia al centro del núcleo*
> (`funneling light beam converging into the center core`,
> `radial volumetric lighting tapering into the central core`).

---

## 5. Prompt para modelo de imagen o vídeo

```
Full mechanical assembly breakdown of an Industrial Arc Reactor. Concentric
layer architecture aligned along the Z-axis with inward funnel geometry:
Core: Bright white-cyan (#00f0ff) glowing plasma lens surrounded by a
micro-notched metallic retaining bezel.
Conical Sleeve: A truncated 3D conical housing tapering inward from the
outer structure directly into the central core lens along the Z-axis.
Internal Cogs: Dual counter-rotating cog rings with visible gear teeth and
circular weight-reduction cutouts.
Slotted Ring: Intermediate circular plate featuring 36 radial precision
light slots and 6 hexagonal front-facing retention bolts.
Support Struts: Radial structural arms connecting the outer frame to the
inner conical housing with mini hydraulic pistons.
Outer Frame: Heavy-duty brushed dark steel ring with industrial wear and
subtle rust edges.
Perimeter Latches: Exactly 10 blocky electromagnetic hydraulic latches
radially spaced at 36-degree intervals around the outer ring perimeter.
Wiring Harness: Thick black power cables and conduits looping out from each
of the 10 outer latches into the rear chassis.
Perspective: Exact geometric alignment, perfectly centered volumetric depth,
photorealistic sci-fi mechanical blueprint execution, no detached or
floating elements.
```

Variante corta para vídeo (ojos en el embudo, no en la geometría):

> Radial volumetric lighting tapering into the central Arc core. Every light
> beam converges on the exact center point of the lens, seen from a deep
> frontal perspective. No floating cones, no detached objects, no long thin
> radial lines.
