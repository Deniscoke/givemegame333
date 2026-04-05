const tiles = document.querySelectorAll('.tile')

const onHover = (event) => {
  const photo = event.currentTarget.querySelector('.photo')
  const scale = event.currentTarget.getAttribute('data-scale')

  gsap.to(photo, {
    duration: scale,
    ease: 'power4.out',
    scale: event.type === 'mouseover' ? scale : 1,
  })
}

const onMove = (event) => {
  const tile = event.currentTarget
  const photo = tile.querySelector('.photo')
  const container = tile.parentElement
  const x = event.clientX
  const y = event.clientY

  gsap.set(photo, {
    transformOrigin: `${((x - tile.offsetLeft - container.getBoundingClientRect().left) / photo.offsetWidth) * 100}% ${((y - tile.offsetTop - container.getBoundingClientRect().top) / photo.offsetHeight) * 100}%`,
  })
}

tiles.forEach((tile) => {
  tile.insertAdjacentHTML('beforeend', `<div class="photo" style="background-image: url(${tile.getAttribute('data-image')})"></div>`)
  tile.insertAdjacentHTML('beforeend', `<div class="text">${tile.getAttribute('data-scale')}</div>`)

  tile.addEventListener('mouseover', onHover)
  tile.addEventListener('mouseout', onHover)
  tile.addEventListener('mousemove', onMove)
})