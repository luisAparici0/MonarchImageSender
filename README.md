# Monarch Image Sender

App web estática (sin build) para mandarle una imagen a la Monarch por Wi-Fi. Pareja
de [MonarchImageReceiver](../MonarchImageReceiver), que corre en el dispositivo.

## Uso

1. Sirve esta carpeta con cualquier servidor estático, por ejemplo:

   ```
   cd MonarchImageSender
   python3 -m http.server 8000
   ```

   y abre `http://localhost:8000` (o la IP de tu laptop) desde cualquier dispositivo
   en la misma red Wi-Fi que la Monarch — celular, tablet, otra laptop, etc.

2. Escribe la IP que la Monarch muestra al abrir MonarchImageReceiver (en braille y en el
   monitor) y dale "Conectar" (llama a `GET /info` para saber el tamaño real de la pantalla
   braille). Si no la sabes, "Buscar Monarch en la red" prueba todas las IPs de la red
   (`x.y.z.1`–`254`) y se conecta sola.
3. Elige una imagen (archivo o cámara). Se muestra una vista previa aproximada de cómo
   quedará en braille (mismo algoritmo de dithering que corre en el dispositivo).
4. "Enviar a la Monarch" — hace `POST /image?thickness=N` con la imagen original en PNG
   (máx. 2400px de lado). El dispositivo corre el mismo algoritmo que la vista previa, así que
   a zoom 1 se ve igual punto por punto, y al hacer zoom recalcula los puntos con todo el detalle.

Después de enviar (o de mover el grosor), la página le pregunta a la Monarch si KeySoft
aceptó los puntos y si lo que está en los pines coincide con la vista previa. "Probar pines"
muestra un patrón conocido para comprobarlo al tacto.

## Notas

- Requiere que ambos dispositivos estén en la misma red local — no hay relay a internet.
  Las redes de universidad o de invitados suelen aislar a los dispositivos entre sí; ahí
  la conexión falla aunque la IP sea correcta. Usa un hotspot del celular o un router propio.
- GeoGebra se descarga solo al abrir su pestaña, así que la página funciona sin internet.
- Todo el procesamiento final (el que realmente se muestra) ocurre en el dispositivo;
  la vista previa aquí es solo una aproximación para componer la imagen antes de enviarla.
