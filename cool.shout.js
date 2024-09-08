// ==UserScript==
// @name        Roriwalrus shout
// @namespace 	roriwalrus.com
// @version     .079
// @match		 https://www.roriwalrus.com/*
// @license GPL-3.0-or-later; https://www.gnu.org/licenses/gpl-3.0.txt
// @description	Adds fun stuff to roriwalrus's shout.
// @grant       none
// ==/UserScript==

// make a install script on greasyfork and/or other sites

// test to mergedd


var shout = document.getElementsByName ("shout")[0];

// Add functionality to the button
function aa () {
	shout.value+="[u]"+"  [/u] ";
}

// place holder for italiics
function itla(){
  shout.value+="[i]"+"  [/i] ";
}

// Place holder for Bold button
function bodl() {
  shout.value+="[b]"+"  [/b] ";
}

// this is for the menu caled memenu
function memenue () {
  var visa = document.getElementById ('memene').style.visibility;
  
	document.getElementById ('memene').classList.add ('is-active', 'is-complete');
  document.getElementById ('js-XFUniqueId173').classList.add ('is-active');
  shout.value+="clickeed " +visa;
}
// adds the marquee tag
function scrolll () {
  an = document.getElementById ('inpt').value;
  if (an) {                
    shout.value +="[marquee]"+an+"[/marquee]";
  } else {
    shout.value +="[marquee]"  + "      [/marquee]";
  }
}

// ads the reverse marquee tag
function scrollr () {
  an = document.getElementById ('inpt').value;
    if (an) {                
    shout.value +="[rightscroll]"+an+"[/rightscroll]";
  } else {
    shout.value +="[rightscroll]"  + "      [/rightscroll]";
  }
}

// attempt to add button
// var zn = document.getElementsByClassName ('block-header')[4];

// new attempt
var zn = document.getElementsByClassName ('block siropuShoutbox')[0].getElementsByClassName ('block-container')[0].getElementsByClassName ('block-header')[0];
zn.innerHTML +="<button id='newButon' class='button--iconOnly button--link button button--icon' type='button'><u>underline</u></button>";
zn.innerHTML +="<button id='meMenu' type='button' class='button--iconOnly button--link button button--icon' aria-haspopup='true'>something</button";
zn.innerHTML +="<button id='italics' class='button--iconOnly button--link button button--icon'>italics</button>";
zn.innerHTML +="<button id='bold' class='button--iconOnly button--link button button--icon'>bold</button>";
zn.innerHTML +="<input id ='inpt' class='button' type='text' placeholder='Enter text for marquee' style='text-align:left;'>";
zn.innerHTML +="<button id='scroll' class = 'button--iconOnly button--link button button--icon'>Marquee</button>";
zn.innerHTML +="<button id='rscrol' class = 'button--iconOnly button--link button button--icon'>reverse Marquee</button>"

var za ='div  class="menu menu--emoji menu--right is-active is-complete menu--up" data-menu="menu" aria-hidden="false" data-xf-init="siropu-shoutbox-smilies-emoji" data-href="/index.php?editor/smilies-emoji" data-load-target=".js-xfSmilieMenuBody" id="js-XFUniqueId174" style="z-index: 206; left: 867.7px; bottom: -1177.4px;">';
var zb = "<div id= 'memene' class = 'menu menu--up menu--emoji menu--right' aria-hidden = 'false' data-menu = 'menu' style='z-index: 206;'>";
zn.innerHTML += zb +"<div class = 'menu-row'>someding</div><div class = 'menu-row'>stuff"+"</div></div></div>";


// button bar
document.getElementById ('newButon').onclick=function () {aa ();};
document.getElementById ('italics').onclick=function () {itla();};
document.getElementById ('bold').onclick=function () {bodl();};
document.getElementById ('meMenu').onclick=function () {memenue ();};
document.getElementById ('scroll').onclick=function () {scrolll ();};
document.getElementById ('rscrol').onclick=function () {scrollr ();};